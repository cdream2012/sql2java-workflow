/**
 * inventory-builder.test.ts — 验证 prescan index → 下游 inventory artifacts 的纯代码转换
 *
 * inventory 阶段零 LLM 的核心：scanSource 产出内存 InventoryIndex（全字段）后，
 * buildInventoryFromIndex 生成 packages/{PKG}.json + subprograms/{PKG.METHOD}.json +
 * tables/{TABLE}.json + inventory.json，产物须通过对应 Zod schema 校验，且下游可消费。
 * 注：InventoryIndex 经内存对象传入（不再落盘 inventory-index.json）。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { scanSource, scanFileSet, finalizeFileSetResults } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import type { InventoryIndex } from "@workflow/plsql-scanner"
import {
  PackageArtifactSchema, SubprogramArtifactSchema, TableArtifactSchema, InventorySchema,
} from "@workflow/artifact-schemas"
import { resolve } from "node:path"

const FIXTURE_TINY = resolve(import.meta.dirname, "../fixtures/sql/tiny")
let dir: string
let index: InventoryIndex

// 收集 root 下所有 .sql/.pks/.pkb 文件
function collectSql(root: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e.startsWith(".") || e === "node_modules") continue
      const p = join(d, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(sql|pks|pkb)$/i.test(e)) out.push(p)
    }
  }
  walk(root)
  return out
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "inv-builder-"))
  // 用 AST 路径（scanFileSet，保留启用作对照）产全字段 index，验证 buildInventoryFromIndex 转换正确性。
  // 生产 scanSource 已切 regex 主路径（参数/包级声明留空交 LLM 兜底），regex 行为由 scan-regex.test.ts 覆盖。
  const files = collectSql(FIXTURE_TINY)
  const result = scanFileSet(files, FIXTURE_TINY)
  index = finalizeFileSetResults([result], FIXTURE_TINY, "ast")
  mkdirSync(dir, { recursive: true })
}, 60000)

afterAll(() => {
  // tmpdir 由 OS 清理，略
})

describe("buildInventoryFromIndex", () => {
  it("生成 packages/ + subprograms/ + tables/ + inventory.json", () => {
    const r = buildInventoryFromIndex(dir, index)
    expect(r.packageCount).toBe(3)
    expect(r.tableCount).toBe(6)
    const pkgFiles = readdirSync(join(dir, "packages")).filter(f => f.endsWith(".json"))
    // tiny fixture 含独立函数 fn_abc_class → 被 injectStandaloneVirtualPackages 注入为虚拟包
    expect(pkgFiles.map(f => f.replace(".json", "")).sort()).toEqual(["BASE_PKG", "CORE_PKG", "__STANDALONE_FN_ABC_CLASS__"])
    expect(existsSync(join(dir, "subprograms"))).toBe(true)
    expect(existsSync(join(dir, "tables"))).toBe(true)
    expect(existsSync(join(dir, "inventory.json"))).toBe(true)
  })

  it("packages/ 文件通过 PackageArtifactSchema 校验", () => {
    const pkgDir = join(dir, "packages")
    for (const f of readdirSync(pkgDir)) {
      const parsed = JSON.parse(readFileSync(join(pkgDir, f), "utf-8"))
      expect(PackageArtifactSchema.safeParse(parsed).success, `${f} 校验失败`).toBe(true)
    }
  })

  it("subprograms/ 文件通过 SubprogramArtifactSchema 校验", () => {
    const subpDir = join(dir, "subprograms")
    const files = readdirSync(subpDir).filter(f => f.endsWith(".json"))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const parsed = JSON.parse(readFileSync(join(subpDir, f), "utf-8"))
      expect(SubprogramArtifactSchema.safeParse(parsed).success, `${f} 校验失败`).toBe(true)
    }
  })

  it("tables/ 文件通过 TableArtifactSchema 校验", () => {
    const tableDir = join(dir, "tables")
    const files = readdirSync(tableDir).filter(f => f.endsWith(".json"))
    expect(files.length).toBe(6)
    for (const f of files) {
      const parsed = JSON.parse(readFileSync(join(tableDir, f), "utf-8"))
      expect(TableArtifactSchema.safeParse(parsed).success, `${f} 校验失败`).toBe(true)
    }
  })

  it("inventory.json 通过 InventorySchema 校验", () => {
    const inv = JSON.parse(readFileSync(join(dir, "inventory.json"), "utf-8"))
    expect(InventorySchema.safeParse(inv).success).toBe(true)
  })

  it("inventory.json packageNames 覆盖所有包", () => {
    const inv = JSON.parse(readFileSync(join(dir, "inventory.json"), "utf-8"))
    expect(inv.packageNames.sort()).toEqual(["BASE_PKG", "CORE_PKG", "__STANDALONE_FN_ABC_CLASS__"])
  })

  it("CORE_PKG 包文件含 functions/procedures 名字索引 + types + variables", () => {
    const core = JSON.parse(readFileSync(join(dir, "packages", "CORE_PKG.json"), "utf-8"))
    // procedures/functions 仅为名字索引（去重；重载同名只出现一次，重载序号在 subprograms 文件名）
    expect(core.procedures).toContain("CREATE_ITEM")
    expect(core.functions).toContain("GET_ITEM")
    expect(core.types.length).toBe(2)
    expect(core.variables.length).toBe(1)
    expect(core.headerPath).toBeTruthy()
    expect(core.bodyPath).toBeTruthy()
  })

  it("CORE_PKG 子程序详情在 subprograms/（含重载 + 参数 + returnType）", () => {
    const subpDir = join(dir, "subprograms")
    const coreFiles = readdirSync(subpDir).filter(f => f.startsWith("CORE_PKG."))
    // 5 functions + 6 procedures（create_item 重载 2 版多 1 个）→ 12 个子程序文件
    expect(coreFiles.length).toBe(12)
    // 重载：CREATE_ITEM 有两个文件（裸名 + __2）
    const createItemFiles = coreFiles.filter(f => f.startsWith("CORE_PKG.CREATE_ITEM"))
    expect(createItemFiles.length).toBe(2)
    const getItem = JSON.parse(readFileSync(join(subpDir, "CORE_PKG.GET_ITEM.json"), "utf-8"))
    expect(getItem.type).toBe("FUNCTION")
    expect(getItem.returnType).toBe("t_item%ROWTYPE")
    expect(getItem.parameters[0]).toMatchObject({ name: "P_ID", type: "NUMBER", mode: "IN" })
    expect(getItem.bodyLocation.lineRange).toEqual([47, 54])
    // 重载：CREATE_ITEM__2（5 参数版）
    const ci2 = readdirSync(subpDir).find(f => f === "CORE_PKG.CREATE_ITEM__2.json")
    expect(ci2).toBeDefined()
    const ci2Json = JSON.parse(readFileSync(join(subpDir, ci2!), "utf-8"))
    expect(ci2Json.overloadIndex).toBe(2)
    expect(ci2Json.parameters.length).toBe(5)
  })

  it("BASE_PKG 包文件：header-only，5 常量、0 子程序", () => {
    const base = JSON.parse(readFileSync(join(dir, "packages", "BASE_PKG.json"), "utf-8"))
    expect(base.procedures).toHaveLength(0)
    expect(base.functions).toHaveLength(0)
    expect(base.constants).toHaveLength(5)
    expect(base.bodyPath).toBeNull()
    expect(base.headerPath).toBeTruthy()
  })

  it("tables/T_ITEM.json 含列结构 + 主键；inventory.json 含 triggers + sequences", () => {
    const tItem = JSON.parse(readFileSync(join(dir, "tables", "T_ITEM.json"), "utf-8"))
    expect(tItem.columns.length).toBe(10)
    expect(tItem.columns.find((c: any) => c.name === "ITEM_ID")).toMatchObject({ isPrimaryKey: true, nullable: false })
    const inv = JSON.parse(readFileSync(join(dir, "inventory.json"), "utf-8"))
    expect(inv.triggers[0]).toMatchObject({ timing: "after", level: "row", targetTable: "T_ITEM", events: ["update"] })
    expect(inv.sequences.length).toBe(4)
  })

  it("standalone 函数注入为虚拟包子程序", () => {
    const subpDir = join(dir, "subprograms")
    const standalone = readdirSync(subpDir).find(f => f.startsWith("__STANDALONE_FN_ABC_CLASS__."))
    expect(standalone).toBeDefined()
    const sp = JSON.parse(readFileSync(join(subpDir, standalone!), "utf-8"))
    expect(sp.name).toBe("FN_ABC_CLASS")
    expect(sp.type).toBe("FUNCTION")
    expect(sp.returnType).toBe("VARCHAR2")
  })
})

describe("buildInventoryFromIndex 失效依赖图缓存", () => {
  // 修复前：buildDependencyGraph 模块级 cache 按 artifactsDir 常驻，buildInventoryFromIndex 重写
  // subprograms/*.json 后不清缓存 → 同 session 重跑 generateInventory 修正 directCalls 后仍返回旧图。
  it("重写 subprograms 后 buildDependencyGraph 反映新 directCalls（缓存被清，非旧图）", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "inv-cache-"))
    const idx = await scanSource(FIXTURE_TINY)

    // 1) 首次构建：GET_ITEM_OBJ→GET_ITEM 边存在
    buildInventoryFromIndex(cacheDir, idx)
    const { buildDependencyGraph } = await import("@workflow/dependency-graph")
    const g1 = buildDependencyGraph(cacheDir)
    expect(g1.callGraph["CORE_PKG.GET_ITEM_OBJ"] ?? []).toContain("CORE_PKG.GET_ITEM")

    // 2) 改内存 index：把 GET_ITEM_OBJ 的 directCalls 指向另一子程序（CREATE_ITEM），重写 subprograms。
    //    验证缓存失效：重写后 buildDependencyGraph 应反映新 directCalls（非旧缓存）。
    for (const s of idx.subprograms ?? []) {
      if (s.name === "GET_ITEM_OBJ") s.directCalls = [{ package: "CORE_PKG", name: "CREATE_ITEM", line: 1, kind: "procedure" }]
    }
    buildInventoryFromIndex(cacheDir, idx)  // 应清缓存

    // 3) 再构建：若缓存已清，图反映新 directCalls（含 CREATE_ITEM，不含 GET_ITEM）；
    //    若未清（旧图），仍只有 GET_ITEM。
    const g2 = buildDependencyGraph(cacheDir)
    const outs = (g2.callGraph["CORE_PKG.GET_ITEM_OBJ"] ?? []).join(",")
    expect(outs).toContain("CREATE_ITEM")    // 反映新 directCalls（CREATE_ITEM 重载展开为 __1/__2）
    expect(outs).not.toContain("GET_ITEM")   // 旧 GET_ITEM 边已随缓存清除消失
  })
})
