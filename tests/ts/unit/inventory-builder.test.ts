/**
 * inventory-builder.test.ts — buildInventoryFromIndex 失效依赖图缓存回归
 *
 * 修复前：buildDependencyGraph 模块级 cache 按 artifactsDir 常驻，buildInventoryFromIndex 重写
 * subprograms/*.json 后不清缓存 → 同 session 重跑 generateInventory 修正 directCalls 后仍返回旧图。
 *
 * fixture: resources/MFG_ERP（F_ITEM.get_item_obj 同包裸名调 get_item，提供真实调用边）。
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { scanSource } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"

const FIXTURE_MFG = resolve(import.meta.dirname, "../../../resources/MFG_ERP")

describe("buildInventoryFromIndex 失效依赖图缓存", () => {
  // 修复前：buildDependencyGraph 模块级 cache 按 artifactsDir 常驻，buildInventoryFromIndex 重写
  // subprograms/*.json 后不清缓存 → 同 session 重跑 generateInventory 修正 directCalls 后仍返回旧图。
  it("重写 subprograms 后 buildDependencyGraph 反映新 directCalls（缓存被清，非旧图）", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "inv-cache-"))
    const idx = await scanSource(FIXTURE_MFG)

    // 1) 首次构建：F_ITEM.GET_ITEM_OBJ→GET_ITEM 边存在（同包裸名函数调用）
    buildInventoryFromIndex(cacheDir, idx)
    const { buildDependencyGraph } = await import("@workflow/dependency-graph")
    const g1 = buildDependencyGraph(cacheDir)
    expect(g1.callGraph["MFG_ERP.F_ITEM.GET_ITEM_OBJ"] ?? []).toContain("MFG_ERP.F_ITEM.GET_ITEM")

    // 2) 改内存 index：把 GET_ITEM_OBJ 的 directCalls 指向另一子程序（CREATE_ITEM），重写 subprograms。
    //    验证缓存失效：重写后 buildDependencyGraph 应反映新 directCalls（非旧缓存）。
    for (const s of idx.subprograms ?? []) {
      if (s.name === "GET_ITEM_OBJ") s.directCalls = [{ package: "MFG_ERP.F_ITEM", name: "CREATE_ITEM", line: 1, kind: "procedure" }]
    }
    buildInventoryFromIndex(cacheDir, idx)  // 应清缓存

    // 3) 再构建：若缓存已清，图反映新 directCalls（含 CREATE_ITEM，不含 GET_ITEM）；
    //    若未清（旧图），仍只有 GET_ITEM。
    const g2 = buildDependencyGraph(cacheDir)
    const outs = (g2.callGraph["MFG_ERP.F_ITEM.GET_ITEM_OBJ"] ?? []).join(",")
    expect(outs).toContain("CREATE_ITEM")    // 反映新 directCalls
    expect(outs).not.toContain("GET_ITEM")   // 旧 GET_ITEM 边已随缓存清除消失
  })
})
