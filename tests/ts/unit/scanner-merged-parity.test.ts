import { describe, it, expect, beforeAll } from "vitest"
import { scanFileSet, finalizeFileSetResults, type InventoryIndex } from "@workflow/plsql-scanner"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { resolve, join } from "node:path"

const ROOT = resolve(import.meta.dirname, "../../..")
const RES = resolve(ROOT, "resources")

function collectSql(root: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e.startsWith(".") || e === "node_modules" || e === "generated") continue
      const p = join(d, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(sql|pks|pkb)$/i.test(e)) out.push(p)
    }
  }
  walk(root)
  return out
}

/**
 * 回归守卫：header+body 合并文件格式（pkg/<name>.sql 同时含包头与包体）下，AST 路径（保留启用作对照）
 * 必须仍能抽取完整结构，不能因 grammar 缺口整文件降级。生产 scanSource 已切 regex 主路径
 * （参数/包级声明留空交 LLM 兜底），故本守卫直接调 scanFileSet（AST）验证 AST 全字段。
 *
 * 修复前症状：合并文件 → 降级 → 子程序 parameters 全 undefined、types/vars/consts 全 0、
 * 重载过程被去重少算。本测试用真实资源项目 mfg_erp_sql / mfg_erp_sql_tiny（均为合并格式）锁定这些字段。
 */
describe("scanner 合并包文件格式支持(header+body 同文件)", () => {
  let tiny: InventoryIndex
  let big: InventoryIndex
  beforeAll(() => {
    // AST 路径（保留启用作对照）：scanFileSet + finalizeFileSetResults 产全字段 index
    const tinyRoot = resolve(RES, "mfg_erp_sql_tiny")
    const bigRoot = resolve(RES, "mfg_erp_sql")
    tiny = finalizeFileSetResults([scanFileSet(collectSql(tinyRoot), tinyRoot)], tinyRoot, "ast")
    big = finalizeFileSetResults([scanFileSet(collectSql(bigRoot), bigRoot)], bigRoot, "ast")
  }, 180000)

  it("合并格式下每个子程序 parameters 被 AST 抽取(非 undefined)", () => {
    for (const [dir, inv] of [["mfg_erp_sql_tiny", tiny], ["mfg_erp_sql", big]] as const) {
      expect(inv.scannerUsed, `${dir} 应走 AST`).toBe("ast")
      for (const sub of inv.subprograms) {
        expect(Array.isArray(sub.parameters), `${dir}/${sub.belongToPackage}.${sub.name} parameters 应被 AST 抽取`).toBe(true)
      }
    }
  })

  it("tiny: CORE_PKG 重载过程不被去重(含 create_item 两个版本)，bodyLocation.lineRange 指向真实行", () => {
    const coreSubs = tiny.subprograms.filter(s => s.belongToPackage === "CORE_PKG")
    // 12 = header 中声明的 11 个 + create_item 重载第 2 版；修复前降级去重为 11
    expect(coreSubs.length).toBe(12)
    const file = readFileSync(resolve(RES, "mfg_erp_sql_tiny/pkg/core_pkg.sql"), "utf-8").split("\n")
    for (const sub of coreSubs) {
      expect(sub.bodyLocation?.lineRange, `${sub.name} 应有 bodyLocation.lineRange`).toBeDefined()
      const [s] = sub.bodyLocation!.lineRange
      // lineRange 起始行落在合并文件中该过程定义处（验证 body 段行号偏移正确）
      expect(file[s - 1]).toMatch(new RegExp(`\\b${sub.name}\\b`, "i"))
    }
  })

  it("tiny: 合并格式抽取完整结构(types/vars/consts/returnType)", () => {
    const core = tiny.packages.find(p => p.packageName === "CORE_PKG")!
    expect(core.types?.length).toBe(2)        // t_recv_line RECORD + t_recv_tab TABLE
    expect(core.variables?.length).toBe(1)    // g_biz_date
    const coreSubs = tiny.subprograms.filter(s => s.belongToPackage === "CORE_PKG")
    expect(coreSubs.filter(s => s.returnType != null).length).toBe(5) // 5 个 FUNCTION
    const base = tiny.packages.find(p => p.packageName === "BASE_PKG")!
    expect(base.constants?.length).toBe(5)    // 修复前 consts 全 0
  })

  it("big: 业务包 bodyLocation.lineRange 指向合并文件真实行(抽样 costing_pkg)", () => {
    const costingSubs = big.subprograms.filter(s => s.belongToPackage === "COSTING_PKG")
    expect(costingSubs.length).toBeGreaterThan(0)
    const file = readFileSync(resolve(RES, "mfg_erp_sql/pkg/costing_pkg.sql"), "utf-8").split("\n")
    for (const sub of costingSubs) {
      expect(sub.bodyLocation?.lineRange, `${sub.name} 应有 bodyLocation.lineRange`).toBeDefined()
      const [s] = sub.bodyLocation!.lineRange
      expect(file[s - 1]).toMatch(new RegExp(`\\b${sub.name}\\b`, "i"))
    }
  })
})
