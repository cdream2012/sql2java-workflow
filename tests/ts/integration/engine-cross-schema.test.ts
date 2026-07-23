/**
 * engine-cross-schema.test.ts — 跨 Schema 校验集成测试
 *
 * 新形状：依赖图由 buildDependencyGraph 从 packages/*.json 按需推导（graph.packageNames = packages 文件名）。
 * 测试 validateCrossSchema 的 CrossSchemaFinding 分级（blocking / warning）以及 advance() 的三路分支。
 */

import { describe, it, expect, afterEach } from "vitest"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { type CrossSchemaFinding } from "@workflow/engine-core"
import { createEngineWithTempDir, writeArtifact } from "../helpers/engine-factory"

const RUN_ID = "run-cross-schema"

function writeInv(dir: string, packageNames: string[]) {
  writeArtifact(dir, RUN_ID, "inventory.json", {
    sourcePath: "src", packageNames, tableNames: [], triggers: [], views: [], sequences: [],
  })
  // inventory advance 校验要求 subprograms/ + tables/ 目录存在（空包可为空目录）
  mkdirSync(join(dir, RUN_ID, "subprograms"), { recursive: true })
  mkdirSync(join(dir, RUN_ID, "tables"), { recursive: true })
}
function writePkg(dir: string, pkg: string) {
  writeArtifact(dir, RUN_ID, `packages/${pkg}.json`, {
    packageName: pkg, absolutePaths: [], headerPath: null, bodyPath: null,
    constants: [], variables: [], exceptions: [], types: [], functions: [], procedures: [], estimatedLoc: 0,
  })
}

/** 基础 setup：inventory 含 CORE_PKG + EXTRA_PKG，packages/ 也含两包 */
function setupBaseline(dir: string) {
  writeInv(dir, ["CORE_PKG", "EXTRA_PKG"])
  writePkg(dir, "CORE_PKG")
  writePkg(dir, "EXTRA_PKG")
}

/** 将 run 推到指定阶段（跳过前置阶段的实际执行） */
function pushToPhase(engine: any, phase: string) {
  const run = engine.runs.get(RUN_ID)
  run.currentPhase = phase
  run.status = "running"
  run.phaseHistory = [
    { phase: "inventory", status: "completed", startedAt: "2026-06-15T00:00:00.000Z", completedAt: "2026-06-15T00:01:00.000Z", retryCount: 0 },
    { phase, status: "in_progress", startedAt: "2026-06-15T00:01:00.000Z", retryCount: 0 },
  ]
  engine.persist(run)
}

// ═══════════════════════════════════════════════════════════════
// validateCrossSchema — finding severity 分级
// ═══════════════════════════════════════════════════════════════

describe("validateCrossSchema — 包名一致性", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("依赖图引用的包在 inventory 中存在 → 无 finding", () => {
    ctx = createEngineWithTempDir()
    setupBaseline(ctx.dir)

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(
      { runId: RUN_ID, currentPhase: "analyze", status: "running", phaseHistory: [], metadata: {}, createdAt: "", updatedAt: "" },
      "analyze",
    )
    expect(findings.length).toBe(0)
  })

  it("依赖图缺少包（inventory 有但 packages/ 没有）→ warning", () => {
    ctx = createEngineWithTempDir()
    writeInv(ctx.dir, ["CORE_PKG", "EXTRA_PKG"])
    writePkg(ctx.dir, "CORE_PKG")  // packages/ 缺 EXTRA_PKG → graph.packageNames 缺 EXTRA_PKG

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(
      { runId: RUN_ID, currentPhase: "analyze", status: "running", phaseHistory: [], metadata: {}, createdAt: "", updatedAt: "" },
      "analyze",
    )
    const missing = findings.find(f => f.message.includes("依赖图缺少包: EXTRA_PKG"))
    expect(missing).toBeTruthy()
    expect(missing!.severity).toBe("warning")
  })

  it("inventory 缺少包（packages/ 有但 inventory 没有）→ warning", () => {
    ctx = createEngineWithTempDir()
    writeInv(ctx.dir, ["CORE_PKG"])
    writePkg(ctx.dir, "CORE_PKG")
    writePkg(ctx.dir, "GHOST_PKG")  // packages/ 多 GHOST_PKG → graph 有但 inventory 没

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(
      { runId: RUN_ID, currentPhase: "analyze", status: "running", phaseHistory: [], metadata: {}, createdAt: "", updatedAt: "" },
      "analyze",
    )
    const extra = findings.find(f => f.message.includes("inventory 缺少包: GHOST_PKG"))
    expect(extra).toBeTruthy()
    expect(extra!.severity).toBe("warning")
  })
})

describe("validateCrossSchema — scaffold packageMappings 覆盖（Stage C：原 plan 校验合并到 scaffold）", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("scaffold.packageMappings 未映射包 → warning", () => {
    ctx = createEngineWithTempDir()
    setupBaseline(ctx.dir)
    writeArtifact(ctx.dir, RUN_ID, "scaffold.json", {
      targetProject: {
        groupId: "com.example",
        javaVersion: "1.8", springBootVersion: "2.7.x",
      },
      packageMappings: [
        { plsqlPackage: "CORE_PKG",
          components: [{role:"service"},{role:"service-impl"},{role:"mapper"}] },
        // 缺少 EXTRA_PKG 映射
      ],
    })

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(
      { runId: RUN_ID, currentPhase: "scaffold", status: "running", phaseHistory: [], metadata: {}, createdAt: "", updatedAt: "" },
      "scaffold",
    )
    const missing = findings.find(f => f.message.includes("scaffold.packageMappings 未映射包: EXTRA_PKG"))
    expect(missing).toBeTruthy()
    expect(missing!.severity).toBe("warning")
  })

  it("scope 激活时越界映射包（out-of-scope 包写进 packageMappings）→ warning", () => {
    ctx = createEngineWithTempDir()
    setupBaseline(ctx.dir)
    writeArtifact(ctx.dir, RUN_ID, "scaffold.json", {
      targetProject: {
        groupId: "com.example",
        javaVersion: "1.8", springBootVersion: "2.7.x",
      },
      // scope 只覆盖 CORE_PKG，但 packageMappings 把 out-of-scope 的 EXTRA_PKG 也映射了
      packageMappings: [
        { plsqlPackage: "CORE_PKG",
          components: [{role:"service"},{role:"service-impl"},{role:"mapper"}] },
        { plsqlPackage: "EXTRA_PKG",
          components: [{role:"service"},{role:"service-impl"},{role:"mapper"}] },
      ],
    })

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(
      { runId: RUN_ID, currentPhase: "scaffold", status: "running", phaseHistory: [], metadata: { scopePackages: ["CORE_PKG"] }, createdAt: "", updatedAt: "" },
      "scaffold",
    )
    const overflow = findings.find(f => f.message.includes("scaffold.packageMappings 越界映射包: EXTRA_PKG"))
    expect(overflow).toBeTruthy()
    expect(overflow!.severity).toBe("warning")
    const falseMissing = findings.find(f => f.message.includes("scaffold.packageMappings 未映射包: EXTRA_PKG"))
    expect(falseMissing).toBeFalsy()
  })

  it("scope 激活时 out-of-scope 包未映射不误报", () => {
    ctx = createEngineWithTempDir()
    setupBaseline(ctx.dir)
    writeArtifact(ctx.dir, RUN_ID, "scaffold.json", {
      targetProject: {
        groupId: "com.example",
        javaVersion: "1.8", springBootVersion: "2.7.x",
      },
      packageMappings: [
        { plsqlPackage: "CORE_PKG",
          components: [{role:"service"},{role:"service-impl"},{role:"mapper"}] },
      ],
    })

    const findings: CrossSchemaFinding[] = ctx.engine.validateCrossSchema(
      { runId: RUN_ID, currentPhase: "scaffold", status: "running", phaseHistory: [], metadata: { scopePackages: ["CORE_PKG"] }, createdAt: "", updatedAt: "" },
      "scaffold",
    )
    const falseMissing = findings.find(f => f.message.includes("scaffold.packageMappings 未映射包: EXTRA_PKG"))
    expect(falseMissing).toBeFalsy()
    const overflow = findings.find(f => f.message.includes("scaffold.packageMappings 越界映射包"))
    expect(overflow).toBeFalsy()
  })
})

// ═══════════════════════════════════════════════════════════════
// advance() — warning 自动放行
// ═══════════════════════════════════════════════════════════════

describe("advance() — warning 自动放行", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("依赖图缺少包 → warning 自动放行（不再 blocking）", () => {
    ctx = createEngineWithTempDir()
    const engine = ctx.engine
    engine.start("sql2java", RUN_ID)
    pushToPhase(engine, "inventory")

    // inventory 两包，packages/ 只 CORE_PKG（graph 缺 EXTRA_PKG）
    writeInv(ctx.dir, ["CORE_PKG", "EXTRA_PKG"])
    writePkg(ctx.dir, "CORE_PKG")

    const result = engine.advance(RUN_ID)
    expect(result.rejected).toBe(false)
    expect(result.crossSchemaWarnings).toBeDefined()
    expect(result.crossSchemaWarnings!.some(w => w.includes("EXTRA_PKG"))).toBe(true)
  })

  it("inventory 缺少包 → warning 自动放行", () => {
    ctx = createEngineWithTempDir()
    const engine = ctx.engine
    engine.start("sql2java", RUN_ID)
    pushToPhase(engine, "inventory")

    // inventory 只 CORE_PKG，packages/ 有 CORE_PKG + GHOST_PKG（graph 多 GHOST_PKG）
    writeInv(ctx.dir, ["CORE_PKG"])
    writePkg(ctx.dir, "CORE_PKG")
    writePkg(ctx.dir, "GHOST_PKG")

    const result = engine.advance(RUN_ID)
    expect(result.rejected).toBe(false)
    expect(result.crossSchemaWarnings).toBeDefined()
    expect(result.crossSchemaWarnings!.length).toBeGreaterThan(0)
  })

  it("acceptWarnings=true 同样放行，附带 crossSchemaWarnings（兼容旧调用方式）", () => {
    ctx = createEngineWithTempDir()
    const engine = ctx.engine
    engine.start("sql2java", RUN_ID)
    pushToPhase(engine, "inventory")

    writeInv(ctx.dir, ["CORE_PKG"])
    writePkg(ctx.dir, "CORE_PKG")
    writePkg(ctx.dir, "GHOST_PKG")

    const result = engine.advance(RUN_ID, { acceptWarnings: true })
    expect(result.rejected).toBe(false)
    expect(result.crossSchemaWarnings).toBeDefined()
    expect(result.crossSchemaWarnings!.length).toBeGreaterThan(0)
  })
})

describe("advance() — 混合场景", () => {
  let ctx: ReturnType<typeof createEngineWithTempDir>
  afterEach(() => ctx?.cleanup())

  it("同时有多条 warning → 全部自动放行，附带在 crossSchemaWarnings", () => {
    ctx = createEngineWithTempDir()
    const engine = ctx.engine
    engine.start("sql2java", RUN_ID)
    pushToPhase(engine, "inventory")

    // inventory 有 CORE_PKG + EXTRA_PKG，packages/ 有 CORE_PKG + GHOST_PKG
    // → EXTRA_PKG: 依赖图缺少包 = warning
    // → GHOST_PKG: inventory 缺少包 = warning
    writeInv(ctx.dir, ["CORE_PKG", "EXTRA_PKG"])
    writePkg(ctx.dir, "CORE_PKG")
    writePkg(ctx.dir, "GHOST_PKG")

    const result = engine.advance(RUN_ID)
    expect(result.rejected).toBe(false)
    expect(result.crossSchemaWarnings).toBeDefined()
    expect(result.crossSchemaWarnings!.some(w => w.includes("EXTRA_PKG"))).toBe(true)
    expect(result.crossSchemaWarnings!.some(w => w.includes("GHOST_PKG"))).toBe(true)
  })
})
