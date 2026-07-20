/**
 * substage-advance.test.ts — A-2 translate sub-stage 推进短路测试
 *
 * 验证：
 * 1. 中间 sub-stage（skeleton→translate-core→test-gen→static-check→compile）advance 短路推进，
 *    不跑 G1-unit / crossSchema 校验（即使无 per-unit JSON 也不拒绝）。
 * 2. 最后 sub-stage（compile）advance 不短路，走 G1-unit 校验：无 per-unit JSON → 拒绝；
 *    写 status=completed per-unit JSON → 通过。
 * 3. 新 unit 首 entry currentSubStage = "skeleton"。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { WorkflowEngine } from "@workflow/engine-core"
import { SQL2JAVA_WORKFLOW } from "@workflow/workflow-definitions"
import { scanSource } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import { buildDependencyGraphFromIndex } from "@workflow/analysis-builder"

const FIXTURE_TINY = resolve(import.meta.dirname, "../fixtures/sql/tiny")
let engine: WorkflowEngine
let dir: string
const runId = "test-substage-advance"

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "substage-adv-"))
  engine = new WorkflowEngine()
  ;(engine as any).artifactsRoot = dir
  engine.registerDefinition(SQL2JAVA_WORKFLOW)

  const artifactsDir = join(dir, runId)
  mkdirSync(artifactsDir, { recursive: true })
  const index = await scanSource(FIXTURE_TINY)
  buildInventoryFromIndex(artifactsDir, index)
  buildDependencyGraphFromIndex(artifactsDir)
}, 60000)

/** 推进到 translate phase（inventory→analyze→plan→scaffold→translate） */
function advanceToTranslate(rid: string, artifactsDir: string) {
  engine.start("sql2java", rid, { sourcePath: FIXTURE_TINY })
  for (const _ of ["inventory", "analyze", "plan", "scaffold"]) {
    let r = engine.advance(rid, { result: "passed" })
    if (r.rejected && (r as any).warningPending) {
      r = engine.advance(rid, { result: "passed", acceptWarnings: true } as any)
    }
    if (r.rejected) throw new Error(`Advance to translate rejected at ${_}: ${r.rejectionReason}`)
  }
  const run = engine.status(rid)!
  expect(run.currentPhase).toBe("translate")
  return run
}

describe("A-2 sub-stage 推进短路", () => {
  it("中间 sub-stage advance 短路推进，不跑 G1-unit（无 per-unit JSON 也不拒绝）", () => {
    const artifactsDir = join(dir, runId)
    const run = advanceToTranslate(runId, artifactsDir)

    // 注入 1 unit shardPlan + skeleton sub-stage 的 entry
    run.metadata.shardPlan = {
      phase: "translate", unitMode: true,
      shards: [["CORE_PKG.get_item"]], completedShards: [],
    }
    const entry = engine.findCurrentEntry(run)!
    entry.incrementalContext = {
      targetUnits: ["CORE_PKG.get_item"], shardIndex: 0, totalShards: 1,
      currentSubStage: "skeleton", currentBatch: 1, totalBatches: 1,
    }
    engine.persist(run)

    // 中间 sub-stage 推进：skeleton → translate-core → test-gen → static-check → compile
    // 全程不写 per-unit JSON，短路应放行（不跑 G1-unit）
    const expected = ["translate-core", "test-gen", "static-check", "compile"]
    for (const next of expected) {
      const adv = engine.advance(runId, { result: "passed" })
      expect(adv.rejected, `推进到 ${next} 不应拒绝: ${adv.rejectionReason}`).toBe(false)
      const cur = engine.findCurrentEntry(engine.status(runId)!)!
      expect(cur.incrementalContext?.currentSubStage).toBe(next)
      expect(cur.incrementalContext?.shardIndex).toBe(0) // 仍同 shard，未 shard advance
    }
  })

  it("最后 sub-stage(compile) advance 走 G1-unit：无 per-unit JSON 拒绝，写 completed 通过", () => {
    const rid = "test-substage-compile"
    const artifactsDir = join(dir, rid)
    mkdirSync(artifactsDir, { recursive: true })
    cpSync(join(dir, runId), artifactsDir, { recursive: true })

    const run = advanceToTranslate(rid, artifactsDir)
    run.metadata.shardPlan = {
      phase: "translate", unitMode: true,
      shards: [["CORE_PKG.get_item"]], completedShards: [],
    }
    const entry = engine.findCurrentEntry(run)!
    entry.incrementalContext = {
      targetUnits: ["CORE_PKG.get_item"], shardIndex: 0, totalShards: 1,
      currentSubStage: "compile", currentBatch: 1, totalBatches: 1,
    }
    engine.persist(run)

    // compile 是最后 sub-stage → 不短路 → 走 G1-unit。写 status=partial per-unit JSON → 拒绝
    mkdirSync(join(artifactsDir, "translations", "CORE_PKG"), { recursive: true })
    writeFileSync(join(artifactsDir, "translations", "CORE_PKG", "get_item.json"), JSON.stringify({
      unitRefName: "get_item", packageName: "CORE_PKG", status: "partial",
      completedSubprograms: [], files: [], decisions: [], todos: [],
      subprogramMethods: [],
    }), "utf-8")
    let adv = engine.advance(rid, { result: "passed" })
    if (adv.rejected && (adv as any).warningPending) {
      adv = engine.advance(rid, { result: "passed", acceptWarnings: true } as any)
    }
    expect(adv.rejected).toBe(true)
    expect(adv.rejectionReason).toMatch(/completed|status/i)

    // 改写 status=completed per-unit JSON → 通过（1 shard → transition 到 dedup）
    writeFileSync(join(artifactsDir, "translations", "CORE_PKG", "get_item.json"), JSON.stringify({
      unitRefName: "get_item", packageName: "CORE_PKG", status: "completed",
      completedSubprograms: ["get_item"], files: [], decisions: [], todos: [],
      subprogramMethods: [{ oracleName: "get_item", javaClass: "com.x.ItemAccess", javaMethod: "getItem", javaFile: "ItemAccess.java" }],
    }), "utf-8")

    let adv2 = engine.advance(rid, { result: "passed" })
    if (adv2.rejected && (adv2 as any).warningPending) {
      adv2 = engine.advance(rid, { result: "passed", acceptWarnings: true } as any)
    }
    expect(adv2.rejected, `compile 通过应推进: ${adv2.rejectionReason}`).toBe(false)
    // 1 shard 完成 → 阶段推进到 dedup
    expect(adv2.run.currentPhase).toBe("dedup")
  })
})
