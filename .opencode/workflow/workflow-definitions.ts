/**
 * Workflow Definitions — SQL2JAVA 单流水线工作流定义
 *
 * 7 个阶段 + 1 个条件分支阶段（fix），一个 runId。
 * 无条件前进 + review/verify 失败时进入 fix 循环（增量重做）。
 */

import type { WorkflowDefinition } from "./engine-core"

// ============================================================================
// SQL2JAVA 单流水线工作流
// ============================================================================

export const SQL2JAVA_WORKFLOW: WorkflowDefinition = {
  id: "sql2java",
  phases: [
    {
      name: "inventory",
      agentFile: "agent/sql-analyst.md",
      temperature: 0.1,
      maxRetries: 2,
      tools: ["read", "bash", "write", "workflow"],
    },
    {
      name: "analyze",
      agentFile: "agent/sql-analyst.md",
      temperature: 0.1,
      maxRetries: 2,
      tools: ["read", "bash", "write", "workflow"],
    },
    {
      name: "plan",
      agentFile: "agent/java-architect.md",
      temperature: 0.2,
      maxRetries: 1,
      requiresConfirmation: true,
      tools: ["read", "bash", "write", "edit", "workflow"],
    },
    {
      name: "scaffold",
      agentFile: "agent/java-architect.md",
      temperature: 0.2,
      maxRetries: 1,
      tools: ["read", "bash", "write", "edit", "workflow"],
    },
    {
      name: "translate",
      agentFile: "agent/translator.md",
      temperature: 0.1,
      maxRetries: 3,
      tools: ["read", "bash", "write", "edit", "workflow"],
    },
    {
      name: "review",
      agentFile: "agent/reviewer.md",
      temperature: 0.1,
      maxRetries: 1,
      tools: ["read", "bash", "write", "workflow"],
    },
    {
      name: "verify",
      agentFile: "agent/reviewer.md",
      temperature: 0.1,
      maxRetries: 2,
      tools: ["read", "bash", "write", "workflow"],
    },
    {
      name: "fix",
      agentFile: "agent/translator.md",
      temperature: 0.1,
      maxRetries: 3,
      isFixPhase: true,
      tools: ["read", "bash", "write", "edit", "workflow"],
    },
  ],

  transitions: [
    // ── 主线：无条件前进 ──
    { from: "inventory",  condition: "always",  to: "analyze" },
    { from: "analyze",    condition: "always",  to: "plan" },
    { from: "plan",       condition: "always",  to: "scaffold" },
    { from: "scaffold",   condition: "always",  to: "translate" },
    { from: "translate",  condition: "always",  to: "review" },
    // ── review 分支 ──
    { from: "review",     condition: "passed",  to: "verify" },
    { from: "review",     condition: "failed",  to: "fix" },
    // ── verify 分支 ──
    { from: "verify",     condition: "passed",  to: "__done__" },
    { from: "verify",     condition: "failed",  to: "fix" },
    // ── fix 回环：D7 动态路由，不在此写死 ──
  ],
}

// ============================================================================
// Upstream Artifacts 映射
// ============================================================================

/** 每个 phase 需要读取的上游 artifact 路径模板 */
export const UPSTREAM_ARTIFACTS: Record<string, string[]> = {
  inventory: [],
  analyze: ["inventory.json"],
  plan: ["inventory.json", "analysis.json", "fsd/*/*.md"],
  scaffold: ["plan.json", "inventory.json"],
  translate: ["inventory.json", "plan.json", "analysis.json", "scaffold.json", "fsd/*/*.md"],
  review: ["plan.json", "scaffold.json", "analysis.json", "translations/*/translation.json"],
  verify: ["plan.json", "scaffold.json", "translations/*/translation.json"],
  fix: ["analysis.json", "plan.json", "scaffold.json"],
}

// ============================================================================
// --phases 前置依赖校验表
// ============================================================================

/** 目标阶段 → 必须存在的 artifact 文件名 */
export const PHASE_PREREQUISITES: Record<string, string[]> = {
  analyze: ["inventory.json"],
  plan: ["inventory.json", "analysis.json"],
  scaffold: ["plan.json", "inventory.json"],
  translate: ["inventory.json", "analysis.json", "plan.json", "scaffold.json"],
  review: ["plan.json", "scaffold.json", "analysis.json"],
  verify: ["plan.json", "scaffold.json"],
  fix: ["analysis.json", "plan.json", "scaffold.json"],
}
