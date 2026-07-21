/**
 * substage-advance.test.ts — translate 主从架构 advance 测试
 *
 * sub-stage 现由 translator master 子 agent 内部经 Task 工具调度，引擎不再逐 sub-stage 推进
 * （Step 2.5 短路已删）。advance 直走 G1-unit 质量门控 + crossSchema + shard advance。
 *
 * 验证：
 * 1. advance 不再短路：无 per-unit JSON / status=partial → G1-unit 拒绝；status=completed → 通过。
 * 2. 新 shard entry 不带 currentSubStage（sub-stage 由 master 内部管）。
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

/** 推进到 translate phase（inventory→scaffold→translate；Stage C：plan 已合并入 scaffold） */
function advanceToTranslate(rid: string) {
  engine.start("sql2java", rid, { sourcePath: FIXTURE_TINY })
  for (const _ of ["inventory", "scaffold"]) {
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

describe("translate 主从架构 advance（无 sub-stage 短路）", () => {
  it("advance 直走 G1-unit：partial 拒绝，completed 通过并阶段推进", () => {
    const rid = "test-substage-advance"
    const artifactsDir = join(dir, rid)
    const run = advanceToTranslate(rid)

    // 注入 1 unit shardPlan（entry 不带 currentSubStage——sub-stage 由 master 内部管）
    run.metadata.shardPlan = {
      phase: "translate", unitMode: true,
      shards: [["CORE_PKG.get_item"]], completedShards: [],
    }
    const entry = engine.findCurrentEntry(run)!
    entry.incrementalContext = {
      targetUnits: ["CORE_PKG.get_item"], shardIndex: 0, totalShards: 1,
    }
    engine.persist(run)

    // 无 per-unit JSON 短路已删 → advance 直走 G1-unit → status=partial 拒绝
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

    // 改写 status=completed → 通过（1 shard → transition 到 dedup）
    writeFileSync(join(artifactsDir, "translations", "CORE_PKG", "get_item.json"), JSON.stringify({
      unitRefName: "get_item", packageName: "CORE_PKG", status: "completed",
      completedSubprograms: ["get_item"], files: [], decisions: [], todos: [],
      subprogramMethods: [{ oracleName: "get_item", javaClass: "com.x.ItemAccess", javaMethod: "getItem", javaFile: "ItemAccess.java" }],
    }), "utf-8")
    let adv2 = engine.advance(rid, { result: "passed" })
    if (adv2.rejected && (adv2 as any).warningPending) {
      adv2 = engine.advance(rid, { result: "passed", acceptWarnings: true } as any)
    }
    expect(adv2.rejected, `completed 应推进: ${adv2.rejectionReason}`).toBe(false)
    expect(adv2.run.currentPhase).toBe("dedup")
  })

  it("新 shard entry 不带 currentSubStage（sub-stage 由 master 内部调度）", () => {
    const rid = "test-substage-shard-entry"
    const artifactsDir = join(dir, rid)
    mkdirSync(artifactsDir, { recursive: true })
    cpSync(join(dir, runId), artifactsDir, { recursive: true })
    const run = advanceToTranslate(rid)

    // 2 unit shardPlan：shard0 完成后 advance → shard advance 到 shard1
    run.metadata.shardPlan = {
      phase: "translate", unitMode: true,
      shards: [["CORE_PKG.get_item"], ["CORE_PKG.put_item"]], completedShards: [],
    }
    const entry = engine.findCurrentEntry(run)!
    entry.incrementalContext = {
      targetUnits: ["CORE_PKG.get_item"], shardIndex: 0, totalShards: 2,
    }
    engine.persist(run)

    // shard0 per-unit JSON completed → advance 触发 shard advance 到 shard1
    mkdirSync(join(artifactsDir, "translations", "CORE_PKG"), { recursive: true })
    writeFileSync(join(artifactsDir, "translations", "CORE_PKG", "get_item.json"), JSON.stringify({
      unitRefName: "get_item", packageName: "CORE_PKG", status: "completed",
      completedSubprograms: ["get_item"], files: [], decisions: [], todos: [],
      subprogramMethods: [{ oracleName: "get_item", javaClass: "com.x.ItemAccess", javaMethod: "getItem", javaFile: "ItemAccess.java" }],
    }), "utf-8")
    let adv = engine.advance(rid, { result: "passed" })
    if (adv.rejected && (adv as any).warningPending) {
      adv = engine.advance(rid, { result: "passed", acceptWarnings: true } as any)
    }
    expect(adv.rejected, `shard0 完成应 shard advance: ${adv.rejectionReason}`).toBe(false)

    const nextEntry = engine.findCurrentEntry(engine.status(rid)!)!
    expect(nextEntry.incrementalContext?.shardIndex).toBe(1)
    expect(nextEntry.incrementalContext?.targetUnits).toEqual(["CORE_PKG.put_item"])
    // 关键：新 entry 不带 currentSubStage
    expect(nextEntry.incrementalContext?.currentSubStage).toBeUndefined()
  })

  it("lint.json / fsd.md 缺失只记 warning 不阻断（master 漏派 slave 观测兜底）", () => {
    const rid = "test-substage-lintfsd-warning"
    const artifactsDir = join(dir, rid)
    mkdirSync(artifactsDir, { recursive: true })
    cpSync(join(dir, runId), artifactsDir, { recursive: true })
    const run = advanceToTranslate(rid)
    run.metadata.shardPlan = {
      phase: "translate", unitMode: true,
      shards: [["CORE_PKG.get_item"]], completedShards: [],
    }
    const entry = engine.findCurrentEntry(run)!
    entry.incrementalContext = { targetUnits: ["CORE_PKG.get_item"], shardIndex: 0, totalShards: 1 }
    engine.persist(run)

    // per-unit JSON completed，但缺 lint.json + fsd .md（master 漏派 static-check/fsd）
    mkdirSync(join(artifactsDir, "translations", "CORE_PKG"), { recursive: true })
    writeFileSync(join(artifactsDir, "translations", "CORE_PKG", "get_item.json"), JSON.stringify({
      unitRefName: "get_item", packageName: "CORE_PKG", status: "completed",
      completedSubprograms: ["get_item"], files: [], decisions: [], todos: [],
      subprogramMethods: [{ oracleName: "get_item", javaClass: "com.x.ItemAccess", javaMethod: "getItem", javaFile: "ItemAccess.java" }],
    }), "utf-8")
    let adv = engine.advance(rid, { result: "passed" })
    if (adv.rejected && (adv as any).warningPending) {
      adv = engine.advance(rid, { result: "passed", acceptWarnings: true } as any)
    }
    // 缺 lint/fsd 只 warning → 不阻断，advance 通过（1 shard → transition dedup）
    expect(adv.rejected, `缺 lint/fsd 应 warning 放行不阻断: ${adv.rejectionReason}`).toBe(false)
    expect(adv.run.currentPhase).toBe("dedup")
    // warning 可见
    const warns = (adv as any).crossSchemaWarnings as string[] | undefined
    expect(warns?.some(w => w.includes("lint.json 缺失"))).toBe(true)
    expect(warns?.some(w => w.includes("fsd") && w.includes(".md 缺失"))).toBe(true)
  })
})
