/**
 * scan-regex.test.ts — scanFileSetRegex 集成测试（regex 主路径）
 *
 * 验证 regex 主路径对一个 file-set 的抽取：包级子程序（过滤嵌套局部过程）、bodyLocation 行号、
 * directCalls（regex 不收窄）、packageRefs、spec/body 合并。parameters/returnType/包级声明留空
 * （LLM 兜底，引擎按 bodyLocation.lineRange 预切 source.sql）。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { scanFileSetRegex, extractPackageRefsByRegex } from "@workflow/plsql-file-scanner"

// spec + body 分文件。body 含三段调用 + 嵌套局部过程 + 跨包常量引用。
const SPEC_SQL = `CREATE OR REPLACE PACKAGE MFG_ERP.P_FOO IS
  PROCEDURE do_work(p IN NUMBER);
  FUNCTION get_val RETURN NUMBER;
  c_max CONSTANT NUMBER := 100;
END P_FOO;
`

const BODY_SQL = `CREATE OR REPLACE PACKAGE BODY MFG_ERP.P_FOO IS
  PROCEDURE do_work(p IN NUMBER) IS
    v NUMBER;
  BEGIN
    MFG_ERP.P_BAR.DO_BAR(p);
    P_BAZ.DO_BAZ(p);
    helper(p);
    v := base_pkg.c_dir_in;
    PROCEDURE inner(x NUMBER) IS
    BEGIN
      NULL;
    END inner;
  END do_work;
  FUNCTION get_val RETURN NUMBER IS
  BEGIN
    RETURN helper(0);
  END get_val;
  PROCEDURE helper(x NUMBER) IS
  BEGIN
    NULL;
  END helper;
END P_FOO;
`

let dir: string
let specFile: string
let bodyFile: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "scan-regex-"))
  specFile = join(dir, "p_foo.pks")
  bodyFile = join(dir, "p_foo.pkb")
  writeFileSync(specFile, SPEC_SQL, "utf-8")
  writeFileSync(bodyFile, BODY_SQL, "utf-8")
})

describe("scanFileSetRegex regex 主路径", () => {
  it("识别包级子程序（spec header + body 实现，过滤嵌套局部过程 inner）", () => {
    const r = scanFileSetRegex([specFile, bodyFile], dir)
    const subs = r.subprograms.filter(s => s.belongToPackage === "MFG_ERP.P_FOO")
    const names = subs.map(s => s.name).sort()
    expect(names).toEqual(["DO_WORK", "GET_VAL", "HELPER"])  // 不含 INNER（嵌套局部过程）
  })

  it("spec/body 合并：do_work 有 headerLocation(spec) + bodyLocation(body)", () => {
    const r = scanFileSetRegex([specFile, bodyFile], dir)
    const dw = r.subprograms.find(s => s.name === "DO_WORK")!
    expect(dw.headerLocation).not.toBeNull()
    expect(dw.bodyLocation).not.toBeNull()
    expect(dw.isPrivate).toBe(false)  // spec 声明 → 非私有
  })

  it("helper 仅 body 无 spec → isPrivate=true", () => {
    const r = scanFileSetRegex([specFile, bodyFile], dir)
    const helper = r.subprograms.find(s => s.name === "HELPER")!
    expect(helper.headerLocation).toBeNull()
    expect(helper.isPrivate).toBe(true)
  })

  it("bodyLocation 行号对齐源码（do_work body [2, 13]）", () => {
    const r = scanFileSetRegex([specFile, bodyFile], dir)
    const dw = r.subprograms.find(s => s.name === "DO_WORK")!
    expect(dw.bodyLocation!.lineRange).toEqual([2, 13])
  })

  it("directCalls 抽三段调用（不收窄，含裸名同包 helper）", () => {
    const r = scanFileSetRegex([specFile, bodyFile], dir)
    const dw = r.subprograms.find(s => s.name === "DO_WORK")!
    const keys = dw.directCalls.map(c => `${c.package}.${c.name}`).sort()
    expect(keys).toContain("MFG_ERP.P_BAR.DO_BAR")   // 3 段
    expect(keys).toContain("MFG_ERP.P_BAZ.DO_BAZ")   // 2 段（补 callerSchema）
    expect(keys).toContain("MFG_ERP.P_FOO.HELPER")   // 1 段裸名同包
  })

  it("inner 嵌套局部过程的调用不串入 do_work directCalls", () => {
    const r = scanFileSetRegex([specFile, bodyFile], dir)
    const dw = r.subprograms.find(s => s.name === "DO_WORK")!
    // inner body 是 NULL，无调用；do_work 的 directCalls 不应含 inner 的内容
    expect(dw.directCalls.some(c => c.name === "INNER")).toBe(false)
  })

  it("packageRefs 抽跨包常量/类型引用（base_pkg.c_dir_in）", () => {
    const r = scanFileSetRegex([specFile, bodyFile], dir)
    const dw = r.subprograms.find(s => s.name === "DO_WORK")!
    const refNames = dw.packageRefs.map(ref => `${ref.package}.${ref.name}`)
    expect(refNames.some(k => k.includes("BASE_PKG") && k.includes("C_DIR_IN"))).toBe(true)
  })

  it("packageRefs 支持引号标识符引用（\"BASE_PKG\".\"C_DIR_IN\" / \"SCHEMA\".\"BASE_PKG\".\"C_VAL\"）", () => {
    // DBMS_METADATA 导出常见引号标识符；refRe 须与 callRe 一致支持引号段，否则漏抽。
    const code = `CREATE OR REPLACE PACKAGE BODY MFG_ERP.P_FOO IS
  PROCEDURE do_work IS
    v NUMBER;
  BEGIN
    v := "BASE_PKG"."C_DIR_IN";
    v := "SCHEMA"."BASE_PKG"."C_VAL";
  END do_work;
END P_FOO;
`
    const refs = extractPackageRefsByRegex(code, "MFG_ERP.P_FOO", [2, 6])
    const names = refs.map(r => `${r.package}.${r.name}`)
    expect(names.some(k => k.includes("BASE_PKG") && k.includes("C_DIR_IN"))).toBe(true)
    expect(names.some(k => k.includes("BASE_PKG") && k.includes("C_VAL"))).toBe(true)
  })

  it("parameters / returnType 留空（LLM 兜底）", () => {
    const r = scanFileSetRegex([specFile, bodyFile], dir)
    const dw = r.subprograms.find(s => s.name === "DO_WORK")!
    expect(dw.parameters).toEqual([])
    const gv = r.subprograms.find(s => s.name === "GET_VAL")!
    expect(gv.returnType).toBeNull()
  })

  it("包级声明不抽（constants 空，LLM 兜底）", () => {
    const r = scanFileSetRegex([specFile, bodyFile], dir)
    const pkg = r.packages.find(p => p.packageName === "MFG_ERP.P_FOO")!
    expect(pkg.constants).toEqual([])  // c_max 不抽（MVP 留空 LLM 兜底）
  })
})
