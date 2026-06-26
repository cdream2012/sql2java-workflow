/**
 * worker-status-gate.test.ts — sharded 阶段 advance 的 status 文件门控（串行硬锁）测试
 *
 * validateArtifactOnDisk 在 sharded 阶段（analyze/translate，shardPlan 存在）advance 前，要求
 * Worker 已写 status/{phase}.json 且 shardIndex 匹配当前分片。缺失/不匹配 → 拒绝（Worker 尚未完成）。
 * 这是 engine 硬锁，防止编排者在 Worker 未完成时 advance 推进到下一分片（跨分片并行 → translate
 * 层级依赖竞态丢方法）。非分片阶段跳过门控。
 *
 * 注：validateArtifactOnDisk 用插件常量 ARTIFACT_DIR=".workflow-artifacts"（相对 cwd），测试在该目录
 * 下建临时 runId 子目录，afterAll 清理。
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { validateArtifactOnDisk } from "@plugins/workflow-engine"
import type { WorkflowRun } from "@workflow/engine-core"

const RUN_ID = `test-status-gate-${process.pid}`
const ARTIFACTS_DIR = join(".workflow-artifacts", RUN_ID)
const STATUS_DIR = join(ARTIFACTS_DIR, "status")

/** 构造一个 sharded 阶段的 run（含 shardPlan + 当前 in_progress 分片 entry） */
function makeShardedRun(phase: "analyze" | "translate", shardIndex: number): WorkflowRun {
  return {
    runId: RUN_ID,
    currentPhase: phase,
    metadata: {
      shardPlan: {
        phase,
        unitMode: true,
        shards: [["PKG.a"], ["PKG.b"]],
        completedShards: [],
      },
    },
    phaseHistory: [
      {
        phase,
        status: "in_progress",
        startedAt: "t",
        retryCount: 0,
        incrementalContext: { targetUnits: ["PKG.a"], shardIndex, totalShards: 2 },
      },
    ],
  } as unknown as WorkflowRun
}

function writeStatus(phase: string, shardIndex: number) {
  writeFileSync(
    join(STATUS_DIR, `${phase}.json`),
    JSON.stringify({ phase, shardIndex, status: "completed" }),
    "utf-8",
  )
}

beforeAll(() => {
  mkdirSync(STATUS_DIR, { recursive: true })
})

afterAll(() => {
  try { rmSync(ARTIFACTS_DIR, { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe("status 文件门控（sharded 阶段串行硬锁）", () => {
  it("sharded 阶段无 status 文件 → 拒绝（Worker 尚未完成）", () => {
    const err = validateArtifactOnDisk(makeShardedRun("translate", 0))
    expect(err).toBeTruthy()
    expect(err).toMatch(/尚未完成/)
    expect(err).toMatch(/status\/translate\.json 缺失/)
  })

  it("status shardIndex 不匹配当前分片 → 拒绝（上一分片残留）", () => {
    writeStatus("translate", 0) // 残留 shard 0 的 status
    const err = validateArtifactOnDisk(makeShardedRun("translate", 1)) // 当前是 shard 1
    expect(err).toMatch(/尚未完成/)
    expect(err).toMatch(/shardIndex/)
    expect(err).toContain("0") // 残留的 shardIndex
  })

  it("status shardIndex 匹配当前分片 → 不因 status 门控拒绝（放行到后续校验）", () => {
    writeStatus("translate", 1) // 匹配当前 shard 1
    const err = validateArtifactOnDisk(makeShardedRun("translate", 1))
    // 门控通过：错误（若有）不应是 status 门控的 "尚未完成"
    expect(err === null || !/尚未完成/.test(err)).toBe(true)
  })

  it("analyze 阶段同样走 status 门控", () => {
    writeStatus("analyze", 0)
    const err = validateArtifactOnDisk(makeShardedRun("analyze", 0))
    expect(err === null || !/尚未完成/.test(err)).toBe(true)
  })

  it("非分片阶段（无 shardPlan）→ 跳过 status 门控", () => {
    // plan 阶段无 shardPlan，即使无 status 文件也不应报 "尚未完成"
    const run = { runId: RUN_ID, currentPhase: "plan", metadata: {} } as unknown as WorkflowRun
    const err = validateArtifactOnDisk(run)
    expect(err === null || !/尚未完成/.test(err)).toBe(true)
  })
})
