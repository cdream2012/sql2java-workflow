/**
 * run-schema-target-units.test.ts — PhaseHistoryEntrySchema.incrementalContext schema 回归
 *
 * bug：incrementalContext.targetPackages 曾被设为**必填**且 schema 无 targetUnits 字段。
 * 但 unit 模式分片（analyze/translate PROCEDURE 级，含 feat/proc-entry-scope 闭包分片）
 * 写的是 `{ targetUnits, shardIndex, totalShards }`（无 targetPackages）→ resume 时
 * loadFromDisk 的 WorkflowRunSchema.safeParse 失败（"targetPackages 字段缺失"），
 * 且即使放过 targetUnits 也会被 Zod 当未知键剥离。修复：targetPackages 改 optional + 补 targetUnits。
 */
import { describe, it, expect } from "vitest"
import { WorkflowRunSchema } from "@workflow/engine-core"

const baseRun = {
  runId: "run-test",
  definitionId: "sql2java",
  currentPhase: "translate",
  status: "running" as const,
  phaseHistory: [],
  metadata: {},
  createdAt: "2026-06-28T00:00:00Z",
  updatedAt: "2026-06-28T00:00:00Z",
}

describe("PhaseHistoryEntrySchema.incrementalContext", () => {
  it("unit 模式（仅 targetUnits，无 targetPackages）→ 校验通过且 targetUnits 不被剥离", () => {
    const run = {
      ...baseRun,
      phaseHistory: [{
        phase: "translate",
        status: "in_progress",
        startedAt: "2026-06-28T00:00:00Z",
        retryCount: 0,
        incrementalContext: {
          targetUnits: ["CORE_PKG.bulk_receive", "CORE_PKG.log_error"],
          shardIndex: 0,
          totalShards: 2,
        },
      }],
    }
    const r = WorkflowRunSchema.safeParse(run)
    expect(r.success).toBe(true)
    if (r.success) {
      const ic = r.data.phaseHistory[0].incrementalContext
      expect(ic?.targetUnits).toEqual(["CORE_PKG.bulk_receive", "CORE_PKG.log_error"])
      expect(ic?.shardIndex).toBe(0)
      expect(ic?.totalShards).toBe(2)
    }
  })

  it("包级模式（仅 targetPackages）→ 仍校验通过", () => {
    const run = {
      ...baseRun,
      phaseHistory: [{
        phase: "review",
        status: "in_progress",
        startedAt: "2026-06-28T00:00:00Z",
        retryCount: 0,
        incrementalContext: { targetPackages: ["CORE_PKG"], shardIndex: 0, totalShards: 1 },
      }],
    }
    expect(WorkflowRunSchema.safeParse(run).success).toBe(true)
  })

  it("incrementalContext 缺省 → 校验通过", () => {
    const run = {
      ...baseRun,
      phaseHistory: [{
        phase: "plan",
        status: "completed",
        startedAt: "2026-06-28T00:00:00Z",
        completedAt: "2026-06-28T00:00:00Z",
        retryCount: 0,
      }],
    }
    expect(WorkflowRunSchema.safeParse(run).success).toBe(true)
  })

  it("incrementalContext 空对象 → 校验通过（两者皆 optional）", () => {
    const run = {
      ...baseRun,
      phaseHistory: [{
        phase: "translate",
        status: "in_progress",
        startedAt: "2026-06-28T00:00:00Z",
        retryCount: 0,
        incrementalContext: {},
      }],
    }
    expect(WorkflowRunSchema.safeParse(run).success).toBe(true)
  })
})
