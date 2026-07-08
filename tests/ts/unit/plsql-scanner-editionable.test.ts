/**
 * 回归测试：stripSqlPlusCommands 的 unitStart 不再依赖单元边界正则。
 *
 * 背景：Oracle 12c+ 导出 PACKAGE BODY 时会在 CREATE OR REPLACE 与 PACKAGE 之间加
 * /*EDITIONABLE* / 注释。旧 unitStart 正则不匹配 → inUnit 全程 false → 单元内
 * EXIT WHEN / UPDATE SET 被当 SQL*Plus 命令误剥 → 语法断裂 → 文件后半段子程序
 * bodyLocation=null → source.sql 切空 → translator 凭空生成 → Aggregate 逻辑对不上。
 *
 * 重构后：grammar 认的命令交给 antlr4，unitStart/unitEnd 边界判断已删，根除该类 bug。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { scanWithAST, scanSource } from "@workflow/plsql-scanner"

const SRC = resolve(import.meta.dirname, "../../../resources/MFG_ERP")

describe("plsql-scanner: Oracle EDITIONABLE 内联注释", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "editionable-"))
    mkdirSync(join(dir, "PACKAGE"))
    mkdirSync(join(dir, "PACKAGE_BODY"))
    copyFileSync(join(SRC, "PACKAGE/F_INVENTORY.sql"), join(dir, "PACKAGE/F_INVENTORY.sql"))
    copyFileSync(join(SRC, "PACKAGE_BODY/F_INVENTORY.sql"), join(dir, "PACKAGE_BODY/F_INVENTORY.sql"))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("F_INVENTORY PACKAGE_BODY 全部子程序 body 不丢失", async () => {
    const inv = await scanWithAST([join(dir, "PACKAGE"), join(dir, "PACKAGE_BODY")], dir)
    const fInv = inv.subprograms.filter((s) => s.belongToPackage === "MFG_ERP.F_INVENTORY")
    expect(fInv.length).toBeGreaterThan(0)

    const noBody = fInv.filter((s) => s.bodyLocation === null)
    expect(noBody, `body 缺失: ${noBody.map((s) => s.name).join(", ")}`).toHaveLength(0)

    // 修复前这 6 个 bodyLocation=null（文件 290 行之后全部丢失）
    for (const name of [
      "BULK_RECEIVE",
      "ADJUST_STOCK",
      "TRANSFER_STOCK",
      "SYNC_BALANCE",
      "GET_AVAILABLE",
      "ARCHIVE_TXNS_BEFORE",
    ]) {
      const s = fInv.find((x) => x.name === name)
      expect(s, `缺失子程序 ${name}`).toBeDefined()
      expect(s!.bodyLocation, `${name} bodyLocation 为 null`).not.toBeNull()
    }
  })
})

// ── extractPackageNames 分区鲁棒性：CREATE 语句含 EDITIONABLE literal / 行注释时，
// body 必须仍能与 spec 分到同一 file-set（共享 Map），否则 spec/body 分裂成两个槽位
//（header-only + body-only），header 槽位 bodyLocation=null 且被误判为重载。──
describe("plsql-scanner: CREATE 语句含 EDITIONABLE literal / 行注释的分区", () => {
  const SPEC = `CREATE OR REPLACE PACKAGE mypkg AS\nPROCEDURE foo(p IN NUMBER);\nEND mypkg;\n/\n`

  async function scanWithBody(body: string) {
    const d = mkdtempSync(join(tmpdir(), "ed-lit-"))
    writeFileSync(join(d, "mypkg.pks"), SPEC, "utf-8")
    writeFileSync(join(d, "mypkg.pkb"), body, "utf-8")
    return scanSource(d)
  }

  it("EDITIONABLE literal 关键字：FOO 单槽位且 bodyLocation 非空", async () => {
    const idx = await scanWithBody(
      `CREATE OR REPLACE EDITIONABLE PACKAGE BODY mypkg AS\nPROCEDURE foo(p IN NUMBER) IS\nBEGIN NULL; END;\nEND mypkg;\n/\n`,
    )
    const foos = idx.subprograms.filter((s) => s.name === "FOO" && s.belongToPackage === "MYPKG")
    expect(foos.length, "EDITIONABLE literal 不应分裂为多槽位").toBe(1)
    expect(foos[0].bodyLocation, "bodyLocation 不应为 null").not.toBeNull()
    expect(foos[0].headerLocation, "headerLocation 不应为 null").not.toBeNull()
  })

  it("CREATE 语句含 -- 行注释：FOO 单槽位且 bodyLocation 非空", async () => {
    const idx = await scanWithBody(
      `CREATE OR REPLACE -- a comment\nPACKAGE BODY mypkg AS\nPROCEDURE foo(p IN NUMBER) IS\nBEGIN NULL; END;\nEND mypkg;\n/\n`,
    )
    const foos = idx.subprograms.filter((s) => s.name === "FOO" && s.belongToPackage === "MYPKG")
    expect(foos.length, "行注释不应分裂为多槽位").toBe(1)
    expect(foos[0].bodyLocation, "bodyLocation 不应为 null").not.toBeNull()
    expect(foos[0].headerLocation, "headerLocation 不应为 null").not.toBeNull()
  })
})
