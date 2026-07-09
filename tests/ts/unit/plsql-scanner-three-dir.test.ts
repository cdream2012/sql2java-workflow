/**
 * plsql-scanner-three-dir.test.ts — 三路径源码扫描单测
 *
 * 验证 scanSource({ sourcePath, headerPath, bodyPath })：
 * - sourcePath(父目录) 作为额外 root，让 header/body 之外的 type/schema 非 包 DDL 被扫到
 * - headerPath/bodyPath 仍保显式配对 + header-first（body-only 私有过程被捕获）
 * - 重复的包文件按绝对路径去重，不产生重复包
 *
 * 对照组：仅 header+body（无 sourcePath）扫不到 schema/ 下的表 —— 证明三路径的差异与必要性。
 */

import { describe, it, expect } from "vitest"
import { resolve } from "node:path"
import { scanSource, scanSourceLazy, type InventoryIndex } from "@workflow/plsql-scanner"

const FIXTURE = resolve(import.meta.dirname, "../fixtures/sql/three-dir")
const PARENT = FIXTURE // sourcePath：header/body/schema 的共同父目录
const HEADER_DIR = resolve(FIXTURE, "header")
const BODY_DIR = resolve(FIXTURE, "body")

describe("scanSource 三路径模式 (sourcePath + headerPath + bodyPath)", () => {
  it("sourcePath 补 schema 表 + header/body 配对 + header-first 保 body-only 私有过程", async () => {
    const index = await scanSource({
      sourcePath: PARENT, headerPath: HEADER_DIR, bodyPath: BODY_DIR,
    }) as InventoryIndex

    // 三路径：primaryBase 优先 sourcePath（父目录），所有文件存相对父目录的可移植路径
    expect(index.sourcePath).toBe(PARENT)

    // 1. 表 accounts 在 schema/ 下，仅当 sourcePath 作为额外 root 被递归扫到
    const accounts = index.tables.find(t => t.name.toUpperCase() === "ACCOUNTS")
    expect(accounts, "schema/accounts.sql 的表应被扫到（证明 sourcePath 额外 root 生效）").toBeDefined()

    // 2. 包按包名跨目录配对，headerPath/bodyPath 均绝对路径
    const pkg = index.packages.find(p => p.packageName.toUpperCase() === "ACCOUNT_MANAGEMENT_PKG")
    expect(pkg, "account_management_pkg 应被跨目录配对").toBeDefined()
    if (pkg) {
      expect(pkg.headerPath).toBe(resolve(HEADER_DIR, "acct.sql"))
      expect(pkg.bodyPath).toBe(resolve(BODY_DIR, "acct.sql"))
    }

    // 3. header-first 仍保住：body-only 私有函数 check_balance_sufficient 被捕获
    const checkBal = index.subprograms.find(
      s => s.belongToPackage === "ACCOUNT_MANAGEMENT_PKG" && s.name === "CHECK_BALANCE_SUFFICIENT",
    )
    expect(checkBal, "body-only 私有函数应被捕获（header-first 顺序未被破坏）").toBeDefined()

    // 4. 去重：包不重复（header 文件被 headerPath 与 sourcePath 两次遍历，但只入索引一次）
    const pkgCount = index.packages.filter(
      p => p.packageName.toUpperCase() === "ACCOUNT_MANAGEMENT_PKG",
    ).length
    expect(pkgCount).toBe(1)
  })

  it("对照组：仅 header+body（无 sourcePath）扫不到 schema/ 下的表", async () => {
    const index = await scanSource({ headerPath: HEADER_DIR, bodyPath: BODY_DIR }) as InventoryIndex
    const accounts = index.tables.find(t => t.name.toUpperCase() === "ACCOUNTS")
    expect(accounts, "无 sourcePath 时 schema/ 表不应被扫到").toBeUndefined()
    // 包仍配对
    const pkg = index.packages.find(p => p.packageName.toUpperCase() === "ACCOUNT_MANAGEMENT_PKG")
    expect(pkg).toBeDefined()
  })

  it("scanSourceLazy 三路径：闭包扫描的 Phase 0 全量抽表也覆盖 sourcePath 下的 schema", async () => {
    const index = await scanSourceLazy({
      sourcePath: PARENT, headerPath: HEADER_DIR, bodyPath: BODY_DIR,
      mainEntry: "account_management_pkg.transfer_money",
    }) as InventoryIndex
    const accounts = index.tables.find(t => t.name.toUpperCase() === "ACCOUNTS")
    expect(accounts, "lazy 闭包扫描也应通过 sourcePath 额外 root 抽到 schema 表").toBeDefined()
    const pkg = index.packages.find(p => p.packageName.toUpperCase() === "ACCOUNT_MANAGEMENT_PKG")
    expect(pkg).toBeDefined()
  })
})
