/**
 * Builder Actions — 确定性 builder action 的 handler 集合（零 LLM）。
 *
 * 从 workflow-engine.ts 的 action dispatch switch 抽出，因这 5 个 action（scan /
 * generateInventory / generateDependencyGraph / generateReviewSummary / generateVerifySummary）
 * 高度自包含：只依赖 args + 模块级 cache/helper + imported builder，不碰 execute 闭包的编排状态。
 * 编排类 action（advance/dispatch/resume/...）仍留在 plugin switch 内——它们耦合 run 状态机，不宜外移。
 *
 * 调用约定：plugin 在主 switch 前先调 runBuilderAction(args, deps)，命中返回 {title,output,metadata}，
 * 未命中（非 builder action）返回 null，plugin 继续走原 switch。
 *
 * loadRunContext / ARTIFACT_DIR 是 plugin 模块级符号（仍被编排路径使用），经 deps 注入避免循环依赖
 * 与重复定义。inventoryIndexCache + scanIndexForRun 仅本 5 个 action 使用，整体迁入此模块。
 */

import { join, resolve } from "node:path"
import { scanSource, scanSourceLazy, type InventoryIndex } from "./plsql-scanner"
import { buildInventoryFromIndex } from "./inventory-builder"
import { buildDependencyGraphFromIndex } from "./analysis-builder"
import { buildReviewSummary } from "./review-summary-builder"
import { buildVerifySummary } from "./verify-summary-builder"
import { getLogger } from "./workflow-logger"

/** plugin 注入的依赖（避免循环 import + 重复定义模块级符号）。 */
export interface BuilderDeps {
  /** artifacts 根目录（plugin 的 ARTIFACT_DIR = resolve(".workflow-artifacts")）。 */
  artifactBase: string
  /** 读 run-context 恢复源码路径（plugin 的 loadRunContext，仍被编排路径使用故注入）。 */
  loadRunContext: (runId: string) => {
    params: { path?: string; headerPath?: string; bodyPath?: string; mainEntry?: string }
  } | null
}

/** builder action 的统一返回形状（与 plugin IIFE 的 {title,output,metadata} 一致）。 */
export interface BuilderActionResult {
  title: string
  output: string
  metadata: Record<string, unknown>
}

// ── inventory scan 内存交接 cache ─────────────────────────────────────────────
// scan action 产出的 InventoryIndex 存此（key=artifactsDir），generateInventory 取此，
// 不再落盘 inventory-index.json——从根源避免大模型读到全量包源码路径等无关上下文。
// 进程重启丢失 cache 时 generateInventory 自扫描兜底（scan 确定性、可重跑）。
const inventoryIndexCache = new Map<string, InventoryIndex>()

/** scanIndexForRun 实际读取的 run-context 结构子集（结构类型，避引 plugin 的 RunContext 致循环依赖）。 */
type RunContextLike = {
  params: { path?: string; headerPath?: string; bodyPath?: string; mainEntry?: string }
}

/**
 * 解析 run 源码路径并跑确定性扫描，返回 InventoryIndex（不落盘）。
 * 供 scan action 与 generateInventory（cache miss 自兜底）复用。返回 null 表示缺源码路径。
 */
async function scanIndexForRun(
  runId: string,
  args: Record<string, unknown>,
  loadRunContext: (runId: string) => RunContextLike | null,
): Promise<InventoryIndex | null> {
  // 路径恢复：优先 args，否则从 run-context（双目录读 headerPath/bodyPath，单目录读 path）
  let srcPath = args.sourcePath as string | undefined
  let headerPath = args.headerPath as string | undefined
  let bodyPath = args.bodyPath as string | undefined
  // mainEntry 从 run-context.params 取（start 时写入）；args 可覆盖。用于 scanSourceLazy 闭包扫描。
  let mainEntry = (args.mainEntry as string | undefined) ?? undefined
  const ctx = loadRunContext(runId)
  // 逐字段从 run-context 补齐：三路径模式(sourcePath+headerPath+bodyPath)下三者独立恢复，
  // 避免 worker 只传 header/body 时把 sourcePath（承载 type/schema 的父目录）漏掉。
  if (ctx) {
    if (!srcPath && ctx.params.path) srcPath = resolve(ctx.params.path)
    if (!headerPath && ctx.params.headerPath) headerPath = resolve(ctx.params.headerPath)
    if (!bodyPath && ctx.params.bodyPath) bodyPath = resolve(ctx.params.bodyPath)
  }
  if (!mainEntry) mainEntry = ctx?.params?.mainEntry
  if (!srcPath && !headerPath && !bodyPath) return null
  // 过程级 mainEntry → 仅解析入口闭包（scanSourceLazy 内部判定过程级，非过程级/无点自动回退全量）。
  // lazy 失败（如入口包不在源码）回退全量，让 advance 期 ensureRunScope 兜底报「入口不可解析」。
  if (mainEntry) {
    try {
      return await scanSourceLazy({ sourcePath: srcPath, headerPath, bodyPath, mainEntry })
    } catch (e: any) {
      getLogger().warn("[scan]", `scanSourceLazy 失败，回退全量 scanSource: ${e?.message ?? e}`)
      return await scanSource({ sourcePath: srcPath, headerPath, bodyPath })
    }
  }
  return await scanSource({ sourcePath: srcPath, headerPath, bodyPath })
}

/**
 * 处理确定性 builder action。命中返回 {title,output,metadata}，否则返回 null（caller 继续主 switch）。
 * action 取值：scan / generateInventory / generateDependencyGraph / generateReviewSummary / generateVerifySummary。
 */
export async function runBuilderAction(
  args: Record<string, unknown>,
  deps: BuilderDeps,
): Promise<BuilderActionResult | null> {
  const action = args.action as string
  const BUILDER_ACTIONS = new Set([
    "scan", "generateInventory", "generateDependencyGraph", "generateReviewSummary", "generateVerifySummary",
  ])
  if (!BUILDER_ACTIONS.has(action)) return null

  if (!args.runId) throw new Error("runId required")
  const runId = args.runId as string
  const artifactsDir = join(deps.artifactBase, runId)

  // ── scan — inventory worker 第 0 步：扫描源码生成 InventoryIndex（内存，不落盘）──
  // worker 在 generateInventory 之前调本 action，跑确定性扫描把 InventoryIndex 存入内存 cache，
  // 下游 generateInventory 从 cache 取（不读盘）。幂等：同 session cache 命中则跳过；空源不入 cache 以便重试。
  if (action === "scan") {
    // 幂等：同 session 内已扫描则复用内存 index（不落盘，resume 重入同进程亦复用）
    if (inventoryIndexCache.has(artifactsDir)) {
      const cached = inventoryIndexCache.get(artifactsDir)!
      return {
        title: "Scan Skipped",
        output: `✔ Scan Skipped | inventory index 已在内存（复用）| ${cached.packages.length} pkgs | ${cached.tables.length} tables`,
        metadata: { runId, skipped: true },
      }
    }
    try {
      const index = await scanIndexForRun(runId, args, deps.loadRunContext)
      if (!index) {
        return {
          title: "Scan Error",
          output: "✖ Scan Error | 缺少源码路径（run metadata 未记录）",
          metadata: { runId, error: "no_source_path" },
        }
      }
      const total = index.packages.length + index.tables.length
        + index.triggers.length + index.standaloneProcedures.length
        + index.views.length + index.sequences.length
      if (total === 0) {
        // 空源不入 cache → 重试可重扫（幂等）
        return {
          title: "Empty Source",
          output: `✖ Empty Source | 源码未找到任何可处理的 PL/SQL 对象（package、table、trigger、standalone procedure）。请确认目录下包含 .sql/.pks/.pkb/.pls 文件。`,
          metadata: { runId, error: "empty_source" },
        }
      }
      inventoryIndexCache.set(artifactsDir, index)
      return {
        title: "Scan Done",
        output: `✔ Scan Done | ${index.scannerUsed} | ${index.packages.length} pkgs | ${index.tables.length} tables | ${index.triggers.length} triggers | ${index.views.length} views | ${index.sequences.length} seqs`,
        metadata: { runId, scannerUsed: index.scannerUsed },
      }
    } catch (e: any) {
      return {
        title: "Scan Error",
        output: `✖ Scan Error | 源码扫描失败: ${e.message}`,
        metadata: { runId, error: e.message },
      }
    }
  }

  // ── generateInventory — inventory 阶段代码生成（由 sql-analyst agent 调用）──
  // inventory 的结构抽取已下沉到 prescan（AST listener 全字段），此处纯代码把内存 InventoryIndex
  // 转成下游 packages/*.json + subprograms/*.json + tables/*.json + inventory.json。
  // agent 调本 action 生成产物 → 输出 WORKER_SUMMARY + TASK_STATUS；编排者调 advance 推进。
  // advance 若被拒（校验失败），编排者重新 dispatch，workOrder 带校验错误，
  // agent 据此最小修复 json（优先）或重跑 generateInventory。
  if (action === "generateInventory") {
    try {
      // 内存交接：优先用 scan 写入的 cache；cache miss（跨进程 resume / 重试未先 scan）则自扫描兜底。
      const cached = inventoryIndexCache.get(artifactsDir)
      const idx = cached ?? await scanIndexForRun(runId, args, deps.loadRunContext)
      if (!idx) {
        return {
          title: "Inventory Generation Failed",
          output: `✖ inventory 代码生成失败：缺少源码路径且无内存 index（scan 可能未运行）。可先调 workflow({action:"scan", runId:"${runId}"})，再重试 generateInventory。`,
          metadata: { runId, error: "no_index" },
        }
      }
      if (!cached) inventoryIndexCache.set(artifactsDir, idx)
      const r = buildInventoryFromIndex(artifactsDir, idx)
      const warn = r.warnings.length > 0
        ? `\n\n⚠️ prescan 降级导致部分元数据用默认值填充（${r.warnings.length} 条）：\n${r.warnings.map(w => `  - ${w}`).join("\n")}`
        : ""
      return {
        title: "Inventory Generated",
        output: `✔ inventory 代码生成完成：${r.packageCount} 包 / ${r.tableCount} 表（已过 Zod 校验）。${warn}\n\n⏹ 请输出 WORKER_SUMMARY + TASK_STATUS 并结束——编排者会调用 advance 推进到 plan。`,
        metadata: { runId, packageCount: r.packageCount, tableCount: r.tableCount, warnings: r.warnings },
      }
    } catch (e: any) {
      return {
        title: "Inventory Generation Failed",
        output: `✖ inventory 代码生成失败：${e.message}\n\n可重试 workflow({action:"generateInventory", runId:"${runId}"})；若反复失败，回退到读源码手工生成 packages + subprograms + tables + inventory.json。`,
        metadata: { runId, error: e.message },
      }
    }
  }

  // ── generateDependencyGraph — inventory 阶段 reduce（零 LLM）──
  // dependency-graph.json 已删——调用图（callGraph/packageDependency/translationOrder/sccGroups/
  // procedureOrder）由 dependency-graph.ts 从 subprograms/*.json 的 directCalls
  // 按需推导，不再落盘。本 action 仅做：complexity 启发式写入 packages/{PKG}.json。
  // agent 在调完 generateInventory 后调本 action。
  // advance 失败时编排者重新 dispatch，workOrder 带校验错误，agent 最小修复 json。
  if (action === "generateDependencyGraph") {
    try {
      const r = buildDependencyGraphFromIndex(artifactsDir)
      return {
        title: "Analysis Meta Generated",
        output: `✔ analysis reduce 完成：complexity 写入 ${r.packageCount} 个 packages/*.json；依赖图 ${r.sccGroupCount} SCC 组（按需从 subprograms.directCalls 推导，不落盘）。${r.warnings.length ? `\n⚠️ ${r.warnings.join("; ")}` : ""}\n\n⏹ 请输出 WORKER_SUMMARY + TASK_STATUS 并结束——编排者会调用 advance 推进。`,
        metadata: { runId, packageCount: r.packageCount, sccGroupCount: r.sccGroupCount, warnings: r.warnings },
      }
    } catch (e: any) {
      return {
        title: "Analysis Meta Generation Failed",
        output: `✖ analysis reduce（complexity）生成失败：${e.message}\n\n可重试 workflow({action:"generateDependencyGraph", runId:"${runId}"})；若反复失败，检查 inventory.json + packages/*.json + subprograms/*.json 是否完整。`,
        metadata: { runId, error: e.message },
      }
    }
  }

  // ── generateReviewSummary — review 阶段代码聚合 review-summary.json（reduce，零 LLM）──
  // review 项目级单次审核：reviewer 写一个 artifactsDir/review.json（packages[] 覆盖全部包）。
  // 本 action 读 review.json（语义）+ review-static.json（静态）合并成顶层 review-summary.json
  // （advance 据其 allPassed 推导 D8）。幂等：可重复调用。
  if (action === "generateReviewSummary") {
    try {
      const r = buildReviewSummary(artifactsDir)
      const warn = r.warnings.length > 0
        ? `\n\n⚠️ ${r.warnings.length} 个 review.json packages[] 条目跳过（解析/校验失败）：\n${r.warnings.map(w => `  - ${w}`).join("\n")}`
        : ""
      return {
        title: "Review Summary Generated",
        output: `✔ review-summary.json 聚合完成：${r.packageCount} 包 / allPassed=${r.allPassed} / totalMustFix=${r.totalMustFix}（已过 Zod 校验）。${warn}\n\n⏹ 请输出 WORKER_SUMMARY + TASK_STATUS 并结束——编排者会调用 advance 推进。`,
        metadata: { runId, packageCount: r.packageCount, allPassed: r.allPassed, totalMustFix: r.totalMustFix, warnings: r.warnings },
      }
    } catch (e: any) {
      return {
        title: "Review Summary Generation Failed",
        output: `✖ review-summary 聚合失败：${e.message}\n\n可重试 workflow({action:"generateReviewSummary", runId:"${runId}"})；若反复失败，检查 artifactsDir/review.json 的 packages[] 是否覆盖全部包。`,
        metadata: { runId, error: e.message },
      }
    }
  }

  // ── generateVerifySummary — verify 阶段代码聚合 verify-summary.json（reduce，零 LLM）──
  // verify 只做动态检查：agent 跑 `mvn compile`/`mvn test`（输出 tee 到 verify-compile.log /
  // verify-test.log），调本 action 由代码解析日志 + 编译/测试失败归因到包 + 聚合 summary。
  // 静态检查（MyBatis 结构、`// TODO: [translate]` 等）归 review，不在 verify。
  if (action === "generateVerifySummary") {
    try {
      const r = buildVerifySummary(artifactsDir)
      const warn = r.warnings.length > 0
        ? `\n\n⚠️ ${r.warnings.length} 条提示：\n${r.warnings.map(w => `  - ${w}`).join("\n")}`
        : ""
      const covText = r.coveragePassed == null
        ? "coverage=skipped"
        : `coverage=line/${((r.lineRate ?? 0) * 100).toFixed(0)}%/branch/${((r.branchRate ?? 0) * 100).toFixed(0)}% passed=${r.coveragePassed}`
      return {
        title: "Verify Summary Generated",
        output: `✔ verify-summary.json 聚合完成：${r.packageCount} 包 / allPassed=${r.allPassed} / compile=${r.compilationSuccess} / tests=${r.testsPassed ?? "?"}/${r.totalTests ?? "?"} / ${covText}（已过 Zod 校验，coverage-gaps.md 已生成）。${warn}\n\n⏹ 请输出 WORKER_SUMMARY + TASK_STATUS 并结束——编排者会调用 advance 推进。`,
        metadata: { runId, packageCount: r.packageCount, allPassed: r.allPassed, compilationSuccess: r.compilationSuccess, testsPassed: r.testsPassed, totalTests: r.totalTests, coveragePassed: r.coveragePassed, lineRate: r.lineRate, branchRate: r.branchRate, warnings: r.warnings },
      }
    } catch (e: any) {
      return {
        title: "Verify Summary Generation Failed",
        output: `✖ verify-summary 聚合失败：${e.message}\n\n可重试 workflow({action:"generateVerifySummary", runId:"${runId}"})；若反复失败，检查 verify-compile.log / verify-test.log 是否已生成、scaffold.json 的 projectRoot 是否正确。`,
        metadata: { runId, error: e.message },
      }
    }
  }

  return null
}
