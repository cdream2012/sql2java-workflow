/**
 * build-sharded-worker-order.test.ts — analyze/translate worker workOrder 端到端渲染
 *
 * 用真实 fixture（tiny）生成 inventory + analysis，构造 unitMode 分片 run，调用
 * buildShardedWorkerOrder 验证 .md 模板渲染产物含分片硬约束 + targetUnits + 切片目录 +
 * 上游 + 无残留占位符，且落盘 dispatch-logs/。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, cpSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { scanSource } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import { buildDependencyGraphFromIndex } from "@workflow/analysis-builder"
import { buildShardedWorkerOrder } from "@plugins/workflow-engine"
import type { WorkflowRun } from "@workflow/engine-core"

const FIXTURE_TINY = resolve(import.meta.dirname, "../fixtures/sql/tiny")
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sharded-wo-"))
}, 60000)

function makeRun(runId: string, phase: string, ic: Record<string, unknown>): WorkflowRun {
  return {
    runId,
    currentPhase: phase,
    status: "running",
    phaseHistory: [{ phase, status: "in_progress", startedAt: "t", retryCount: 0, incrementalContext: ic }],
    metadata: { sourcePath: FIXTURE_TINY },
    createdAt: "t",
    updatedAt: "t",
  } as unknown as WorkflowRun
}

// analyze 阶段已砍（inventory→plan 直连），analyze workOrder 测试跳过，后续清理删。
describe.skip("buildShardedWorkerOrder — analyze", () => {
  let art: string
  beforeAll(async () => {
    const runId = "test-wo-analyze"
    art = join(dir, runId)
    mkdirSync(art, { recursive: true })
    const index = await scanSource(FIXTURE_TINY)
    buildInventoryFromIndex(art, index)
    buildDependencyGraphFromIndex(art) // 产出 dependency-graph.json（含 procedureOrder）
  }, 60000)

  it("渲染 analyze shard 0 workOrder：含分片硬约束 + targetUnits + 切片目录 + 落盘", () => {
    const runId = "test-wo-analyze"
    const run = makeRun(runId, "analyze", {
      targetUnits: ["CORE_PKG.get_item"], shardIndex: 0, totalShards: 13,
    })
    const currentEntry = (run as any).phaseHistory[0]
    const wo = buildShardedWorkerOrder(run, currentEntry, art, null)

    // 分片硬约束 + targetUnits
    expect(wo).toContain("分片范围硬约束")
    expect(wo).toContain("CORE_PKG.get_item")
    expect(wo).toContain("分片 1/13")
    // 切片目录（generateUnitSlices 已落盘 + scopeBlock 引用）
    expect(wo).toContain("shard-inputs/CORE_PKG/get_item/")
    expect(existsSync(join(art, "shard-inputs", "CORE_PKG", "get_item", "source.sql"))).toBe(true)
    // 上游 artifact
    expect(wo).toContain("inventory.json")
    // 无残留占位符
    expect(wo).not.toContain("{{")
    // 落盘 dispatch-logs
    expect(existsSync(join(art, "dispatch-logs", "analyze-shard0.workOrder.md"))).toBe(true)
    expect(readFileSync(join(art, "dispatch-logs", "analyze-shard0.workOrder.md"), "utf-8")).toBe(wo)
    // analyze 在 plan 之前，无 projectRoot
    expect(wo).not.toContain("projectRoot")
  })

  it("脏 entry（unitMode shardPlan 但 targetPackages 整包）自愈成 targetUnits 单 unit", () => {
    // 复现历史脏 run：旧代码在 unitMode=true 下误写 targetPackages 整包名
    const run = makeRun("test-wo-analyze", "analyze", {
      targetPackages: ["CORE_PKG"], shardIndex: 0, totalShards: 13,
    })
    ;(run.metadata as any).shardPlan = {
      phase: "analyze", unitMode: true,
      shards: [["CORE_PKG.get_item"], ["CORE_PKG.get_item_obj"]],
      completedShards: [],
    }
    const currentEntry = (run as any).phaseHistory[0]
    const wo = buildShardedWorkerOrder(run, currentEntry, art, null)

    // 自愈：entry 被补写 targetUnits（= shards[0]），清除脏 targetPackages
    expect(currentEntry.incrementalContext.targetUnits).toEqual(["CORE_PKG.get_item"])
    expect(currentEntry.incrementalContext.targetPackages).toBeUndefined()
    // workOrder 走 unit 模式（非整包）：含正确 unit + PROCEDURE 单元 banner
    expect(wo).toContain("分片范围硬约束")
    expect(wo).toContain("PROCEDURE 单元")
    expect(wo).toContain("CORE_PKG.get_item")
    expect(wo).toContain("shard-inputs/CORE_PKG/get_item/")
  })
})

describe("buildShardedWorkerOrder — translate", () => {
  let art: string
  beforeAll(async () => {
    const runId = "test-wo-translate"
    art = join(dir, runId)
    mkdirSync(art, { recursive: true })
    const index = await scanSource(FIXTURE_TINY)
    buildInventoryFromIndex(art, index)
    buildDependencyGraphFromIndex(art)
    // Stage A 起 projectRoot 由 artifactId（metadata/run-context）决定，不再需要 plan.json。
  }, 60000)

  it("渲染 translate shard workOrder：含依赖签名块 + projectRoot + source.sql 切片", () => {
    const runId = "test-wo-translate"
    const run = makeRun(runId, "translate", {
      targetUnits: ["CORE_PKG.get_item"], shardIndex: 0, totalShards: 13,
    })
    // Stage A：artifactId 由 metadata 提供（start 时写入），引擎据此算 projectRoot，不读 plan。
    ;(run.metadata as Record<string, unknown>).artifactId = "testapp"
    const currentEntry = (run as any).phaseHistory[0]
    const wo = buildShardedWorkerOrder(run, currentEntry, art, null)

    expect(wo).toContain("translate Master 任务")
    expect(wo).toContain("分片范围硬约束")
    expect(wo).toContain("CORE_PKG.get_item")
    // translate 有 projectRoot（Stage A：来自 metadata.artifactId）
    expect(wo).toContain("projectRoot")
    expect(wo).toContain("generated/testapp")
    // source.sql 切片（analyze 砍后不再有 analysis-slice，只 source.sql + meta.json）
    expect(existsSync(join(art, "shard-inputs", "CORE_PKG", "get_item", "source.sql"))).toBe(true)
    expect(existsSync(join(art, "shard-inputs", "CORE_PKG", "get_item", "analysis-slice.json"))).toBe(false)
    // 无残留占位符
    expect(wo).not.toContain("{{")
    // 落盘
    expect(existsSync(join(art, "dispatch-logs", "translate-shard0.workOrder.md"))).toBe(true)
  })
})
