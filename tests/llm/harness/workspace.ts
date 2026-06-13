/**
 * harness/workspace.ts — 执行点预置（触发的核心）
 *
 * prepareExecutionPoint：在隔离 workDir 内，用【真实 engine-core】把 run.json 推进到目标 phase，
 * 并预置上游 artifact + 真实输入 fixture。之后由 runExecutionPoint 调 `opencode run "/sql2java resume"`
 * 复用该 run（status=running 停在目标 phase）续跑，走真实 agent（同源）。
 *
 * 为什么用 resume 而非 --phases：start（branch 3）会 run-{时间戳} 新建 run 并重扫源码、不继承预置
 * artifact（workflow-engine.ts:963-1112）；resume 对 status=running 停在目标 phase 的 run 会读 inventory
 * 确定未完成包并续跑、不重扫（workflow-engine.ts:1608-1637）。
 *
 * 注意：harness 由 tsx（case-loader）和 vitest（oracle 自测）双重加载，故对 .opencode/workflow 用
 * 相对路径引入（@workflow 别名只在 vitest 生效）。
 */

import { WorkflowEngine } from "../../../.opencode/workflow/engine-core"
import { SQL2JAVA_WORKFLOW } from "../../../.opencode/workflow/workflow-definitions"
import { makeReviewSummary, makeVerifySummary } from "../../ts/helpers/artifact-factory"
import { cpSync, existsSync, mkdirSync } from "node:fs"
import { safeRm, safeWriteFile } from "../../../.opencode/workflow/cross-platform"
import { join, resolve } from "node:path"
import type { PhaseName } from "./types"

/** 固定 runId（确定性），artifact 目录 = <workDir>/.workflow-artifacts/<RUN_ID>/ */
export const RUN_ID = "run-test"

/** 主线阶段顺序（fix 为分支阶段，不在线性推进路径上） */
const LINEAR_PHASES = SQL2JAVA_WORKFLOW.phases.map(p => p.name).filter(n => n !== "fix")

export interface PrepareOptions {
  workDir: string
  phase: PhaseName
  sourcePath?: string
  /** 程序化预置上游 artifact（用 artifact-factory 造 mock 桩，或写真实数据） */
  prepareArtifacts?: (artifactsDir: string) => void
  /** 静态 artifact 目录（无 prepareArtifacts 时拷贝） */
  staticArtifactsDir?: string
  /** 程序化预置真实输入（最小 SQL / 含缺陷 Java）到 workDir */
  prepareFixture?: (workDir: string) => void
  /** 静态 fixture 目录（无 prepareFixture 时拷贝到 workDir） */
  staticFixtureDir?: string
}

export interface PreparedWorkspace {
  runId: string
  artifactsDir: string
  workDir: string
}

/**
 * 预置一个停在目标 phase 的 run + 上游 artifact + fixture。
 * 全程不调用 opencode（纯 TS 引擎推进），可被 oracle 自测廉价验证。
 */
export function prepareExecutionPoint(opts: PrepareOptions): PreparedWorkspace {
  const { workDir, phase, sourcePath } = opts
  const absWorkDir = resolve(workDir)
  const artifactsRoot = join(absWorkDir, ".workflow-artifacts")
  const artifactsDir = join(artifactsRoot, RUN_ID)

  // 1. 清理并创建 run artifact 目录（safeRm：Windows 瞬时锁定自动重试；不存在不报错）
  safeRm(artifactsDir)
  mkdirSync(artifactsDir, { recursive: true })

  // 2. 预置上游 artifact（mock 桩或真实数据）
  if (opts.prepareArtifacts) {
    opts.prepareArtifacts(artifactsDir)
  } else if (opts.staticArtifactsDir && existsSync(opts.staticArtifactsDir)) {
    cpSync(opts.staticArtifactsDir, artifactsDir, { recursive: true })
  }

  // 3. 用真实 engine-core 推进 run.json 到目标 phase（同源）
  const engine = new WorkflowEngine()
  // artifactsRoot 默认 ".workflow-artifacts"（相对 cwd）；改为绝对，确保 persist 写入 workDir
  ;(engine as unknown as { artifactsRoot: string }).artifactsRoot = artifactsRoot
  engine.registerDefinition(SQL2JAVA_WORKFLOW)

  const metadata: Record<string, unknown> = {}
  if (sourcePath) metadata.sourcePath = sourcePath
  engine.start("sql2java", RUN_ID, metadata)
  advanceToPhase(engine, RUN_ID, phase, artifactsDir)

  // 4. 预置真实输入 fixture 到 workDir
  if (opts.prepareFixture) {
    opts.prepareFixture(absWorkDir)
  } else if (opts.staticFixtureDir && existsSync(opts.staticFixtureDir)) {
    cpSync(opts.staticFixtureDir, absWorkDir, { recursive: true })
  }

  return { runId: RUN_ID, artifactsDir, workDir: absWorkDir }
}

/**
 * 从 inventory 线性推进到目标 phase。
 * 跨出 review/verify 需要对应 summary（引擎从 summary.allPassed 推导 result）。
 */
function advanceToPhase(engine: WorkflowEngine, runId: string, targetPhase: PhaseName, artifactsDir: string): void {
  if (targetPhase === "fix") {
    throw new Error("不支持直接推进到 fix（分支阶段）；请以 review/verify 为执行点触发")
  }
  const targetIdx = LINEAR_PHASES.indexOf(targetPhase)
  if (targetIdx < 0) throw new Error(`未知目标 phase: ${targetPhase}`)

  for (let i = 0; i < targetIdx; i++) {
    const run = engine.status(runId)!
    // 跨出 review/verify 前补一份通过的 summary（仅推进用，与被测产出无关）
    if (run.currentPhase === "review") {
      writeJson(artifactsDir, "review-summary.json", makeReviewSummary({ allPassed: true }))
    } else if (run.currentPhase === "verify") {
      writeJson(artifactsDir, "verify-summary.json", makeVerifySummary({ allPassed: true }))
    }
    const r = engine.advance(runId)
    if (r.rejected) {
      throw new Error(`advance 被拒绝（离开 ${run.currentPhase}）: ${r.rejectionReason}`)
    }
  }

  const run = engine.status(runId)!
  if (run.currentPhase !== targetPhase) {
    throw new Error(`推进后 currentPhase=${run.currentPhase}，期望 ${targetPhase}`)
  }
}

/** 写 JSON artifact 到 artifact 目录（原子写：tmp→rename，避免半写 JSON 让 oracle 误判） */
function writeJson(artifactsDir: string, filename: string, data: unknown): void {
  safeWriteFile(join(artifactsDir, filename), JSON.stringify(data))
}
