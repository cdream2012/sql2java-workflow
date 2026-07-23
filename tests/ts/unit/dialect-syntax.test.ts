/**
 * dialect-syntax.test.ts — GaussDB/openGauss 方言构造 grammar 支持回归基线
 *
 * 语料：resources/MFG_ERP/PACKAGE_BODY/F_DIALECT.sql，集中放 PL/SQL grammar 原本不支持
 * 的 GaussDB 方言构造：:: 类型转换、LIMIT/LIMIT OFFSET 分页、GET DIAGNOSTICS、缺 FROM DUAL。
 *
 * 验证目标（grammar 增强后应全绿）：
 *   1. 0 语法错误 —— :: / LIMIT / GET DIAGNOSTICS 不再失配；
 *   2. 6 个过程全部识别 —— :: 这类结构性错误不级联吞掉后续过程声明；
 *   3. 每个过程 bodyLocation 非空 —— body 不被错误恢复截断；
 *   4. 每个方言过程 directCalls 含 HELPER_OK —— 错误恢复不吞构造之后的调用；
 *   5. p_diag directCalls 不含 GET/DIAGNOSTICS 假调用 —— get_diagnostics_statement
 *      抢在 call_statement 前匹配，GET 不被当 routine_name 误抽。
 *
 * 直接测 parseFileAst（AST 层，post-filter 前），不依赖 F_UTIL 内容，最稳定。
 */
import { describe, it, expect, beforeAll } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parseFileAst } from "@workflow/plsql-file-scanner"
import type { SubprogramInfo } from "@workflow/plsql-file-scanner"

const SQL_PATH = resolve(import.meta.dirname, "../../../resources/MFG_ERP/PACKAGE_BODY/F_DIALECT.sql")

describe("GaussDB 方言语法 grammar 支持 (F_DIALECT 基线)", () => {
  let subs: SubprogramInfo[]
  let warnings: string[]

  beforeAll(() => {
    const code = readFileSync(SQL_PATH, "utf8")
    const packages = new Map()
    const subprograms = new Map<string, SubprogramInfo[]>()
    const standaloneProcedures: unknown[] = []
    const standaloneSlots: SubprogramInfo[] = []
    warnings = []
    parseFileAst(code, "F_DIALECT.sql", packages, subprograms, standaloneProcedures as any, standaloneSlots, warnings)
    subs = [...subprograms.values()].flat()
  })

  it("0 语法错误（:: / LIMIT / GET DIAGNOSTICS 全部支持）", () => {
    const errs = warnings.filter((w) => w.includes("AST 语法错误:"))
    expect(errs, errs.join("\n")).toHaveLength(0)
  })

  it("6 个过程全部识别（:: 不级联吞后续过程声明）", () => {
    expect(subs.map((s) => s.name).sort()).toEqual(
      ["HELPER_OK", "P_ARRAY", "P_CAST", "P_DIAG", "P_DOLLAR", "P_EMPTY_PAREN", "P_LIMIT", "P_LIMIT_OFFSET", "P_LOGICAL_OR", "P_NO_FROM"],
    )
  })

  it("每个过程 bodyLocation 非空（body 不被错误恢复截断）", () => {
    const noBody = subs.filter((s) => s.bodyLocation === null)
    expect(noBody, `body 缺失: ${noBody.map((s) => s.name).join(", ")}`).toHaveLength(0)
  })

  const DIALECT_PROCS = ["P_CAST", "P_LIMIT", "P_LIMIT_OFFSET", "P_DIAG", "P_NO_FROM", "P_LOGICAL_OR", "P_ARRAY", "P_DOLLAR", "P_EMPTY_PAREN"]
  for (const name of DIALECT_PROCS) {
    it(`${name}: 方言构造之后的调用不漏抽（HELPER_OK 在 directCalls）`, () => {
      const s = subs.find((x) => x.name === name)!
      expect(s.directCalls.map((c) => c.name)).toContain("HELPER_OK")
    })
  }

  it("p_diag: GET/DIAGNOSTICS 不被当假调用（get_diagnostics_statement 优先匹配）", () => {
    const s = subs.find((x) => x.name === "P_DIAG")!
    const names = s.directCalls.map((c) => c.name)
    expect(names).not.toContain("GET")
    expect(names).not.toContain("DIAGNOSTICS")
  })
})
