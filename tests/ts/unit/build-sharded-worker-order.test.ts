/**
 * build-sharded-worker-order.test.ts — analyze/translate worker workOrder 端到端渲染
 *
 * 用真实 fixture（MFG_ERP）生成 inventory + analysis，构造 unitMode 分片 run，调用
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

const FIXTURE_MFG = resolve(import.meta.dirname, "../../../resources/MFG_ERP")
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
    metadata: { sourcePath: FIXTURE_MFG },
    createdAt: "t",
    updatedAt: "t",
  } as unknown as WorkflowRun
}

describe("buildShardedWorkerOrder — translate", () => {
  let art: string
  beforeAll(async () => {
    const runId = "test-wo-translate"
    art = join(dir, runId)
    mkdirSync(art, { recursive: true })
    const index = await scanSource(FIXTURE_MFG)
    buildInventoryFromIndex(art, index)
    buildDependencyGraphFromIndex(art)
    // Stage A 起 projectRoot 由 artifactId（metadata/run-context）决定，不再需要 plan.json。
  }, 60000)

  it("渲染 translate shard workOrder：含依赖签名块 + projectRoot + source.sql 切片", () => {
    const runId = "test-wo-translate"
    const run = makeRun(runId, "translate", {
      targetUnits: ["MFG_ERP.F_ITEM.get_item"], shardIndex: 0, totalShards: 13,
    })
    // Stage A：artifactId 由 metadata 提供（start 时写入），引擎据此算 projectRoot，不读 plan。
    ;(run.metadata as Record<string, unknown>).artifactId = "testapp"
    const currentEntry = (run as any).phaseHistory[0]
    const wo = buildShardedWorkerOrder(run, currentEntry, art, null)

    expect(wo).toContain("translate Master 任务")
    expect(wo).toContain("分片范围硬约束")
    expect(wo).toContain("MFG_ERP.F_ITEM.get_item")
    // translate 有 projectRoot（Stage A：来自 metadata.artifactId）
    expect(wo).toContain("projectRoot")
    expect(wo).toContain("generated/testapp")
    // source.sql 切片（analyze 砍后不再有 analysis-slice，只 source.sql + meta.json）
    expect(existsSync(join(art, "shard-inputs", "MFG_ERP.F_ITEM", "get_item", "source.sql"))).toBe(true)
    expect(existsSync(join(art, "shard-inputs", "MFG_ERP.F_ITEM", "get_item", "analysis-slice.json"))).toBe(false)
    // 无残留占位符
    expect(wo).not.toContain("{{")
    // 落盘完整 system prompt（.systemPrompt.md）——落盘=注入=审核三者一致
    const promptPath = join(art, "dispatch-logs", "translate-shard0.systemPrompt.md")
    expect(existsSync(promptPath)).toBe(true)
    // 落盘内容含 workOrder 段（effectiveAgentFile 缺失时降级为仅 workOrder）
    expect(readFileSync(promptPath, "utf-8")).toContain("translate Master 任务")
  })
})
