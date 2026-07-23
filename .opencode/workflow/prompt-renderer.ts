/**
 * prompt-renderer.ts — worker 任务提示词模板渲染器
 *
 * 把 translate 的 worker 任务从「编排者 LLM 即兴拼凑」改为「.md 模板 + 引擎填变量」：
 * 模板（.opencode/workflow/prompts/{phase}-worker.md）是可 review 的静态骨架，引擎用本分片数据
 * 填充 {{占位符}}（含动态块：scopeBanner / 切片读取清单 / 依赖签名 / upstream / schemaHint /
 * rejectionError）。渲染产物 = workOrder，既落盘可追溯（dispatch-logs/），又注入 worker 系统提示
 * 作权威任务（确定性，不依赖编排者透传）。
 *
 * 占位符语法：{{key}}；未提供的 key 替换为空串；渲染后折叠 3+ 连续空行为 2 行（清理空 section）。
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "prompts")

/** 静态 subtask 触发器（translate 分片用）。读一次缓存——非运行时拼接，可 review。 */
let _subtaskTriggerCache: string | null = null
export function getSubtaskTriggerPrompt(): string {
  if (_subtaskTriggerCache !== null) return _subtaskTriggerCache
  const p = join(TEMPLATES_DIR, "subtask-trigger.md")
  _subtaskTriggerCache = existsSync(p) ? readFileSync(p, "utf-8").trim() : ""
  return _subtaskTriggerCache
}

/** worker 任务上下文 —— 全部字符串（动态块由调用方预渲染后传入，渲染器只做占位符替换）。 */
export type WorkerPromptCtx = Record<string, string>

/**
 * 渲染 worker 任务模板。
 * @param phase    "translate"（其他阶段无模板，抛错；analyze 已砍）
 * @param ctx      占位符 → 值（含动态块字符串）
 * @param subStage A-2：phase 内 sub-stage 名。提供时选 `prompts/{phase}-{subStage}-worker.md`，
 *                 否则回退 `prompts/{phase}-worker.md`。
 * @returns 渲染后的 workOrder 文本
 */
export function renderWorkerPrompt(phase: string, ctx: WorkerPromptCtx, subStage?: string): string {
  const tplName = subStage ? `${phase}-${subStage}-worker.md` : `${phase}-worker.md`
  const tplPath = join(TEMPLATES_DIR, tplName)
  if (!existsSync(tplPath)) {
    throw new Error(`worker prompt template not found: ${tplPath}（phase=${phase}${subStage ? ` subStage=${subStage}` : ""}）`)
  }
  let out = readFileSync(tplPath, "utf-8")
  // 占位符替换（未提供 → 空串）
  out = out.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => ctx[key] ?? "")
  // 折叠 3+ 连续换行为 2 个（清理空 section 留下的多余空行）
  out = out.replace(/\n{3,}/g, "\n\n")
  // 去除行尾空白
  out = out.replace(/[ \t]+\n/g, "\n")
  return out.trim() + "\n"
}

/** 持久化 workOrder 文件名（按分片 + sub-stage 区分，便于追溯每次 dispatch 的精确 prompt）。 */
export function workOrderFileName(phase: string, shardIndex: number | undefined, subStage?: string): string {
  const sub = subStage ? `-${subStage}` : ""
  return shardIndex !== undefined
    ? `${phase}${sub}-shard${shardIndex}.workOrder.md`
    : `${phase}${sub}.workOrder.md`
}

/**
 * 持久化「完整 system prompt」文件名（按分片 + sub-stage 区分）。
 *
 * 设计初衷：dispatch 时一次性拼好 slave/master 的完整 6 段 system prompt 并落盘，使
 * 「落盘文件 = slave 实际收到的 system prompt = 可审核内容」三者一致。system.transform hook
 * 退化为「读盘注入」（旧 run 兜底走 workOrder 现拼）。
 */
export function systemPromptFileName(phase: string, shardIndex: number | undefined, subStage?: string): string {
  const sub = subStage ? `-${subStage}` : ""
  return shardIndex !== undefined
    ? `${phase}${sub}-shard${shardIndex}.systemPrompt.md`
    : `${phase}${sub}.systemPrompt.md`
}

/**
 * 落盘完整 system prompt 到 artifactsDir/dispatch-logs/，供审计追溯 + system.transform 读取注入。
 * 失败不阻断 dispatch（warn 由调用方处理）。
 */
export function persistSystemPrompt(
  artifactsDir: string,
  phase: string,
  shardIndex: number | undefined,
  content: string,
  subStage?: string,
): void {
  const dir = join(artifactsDir, "dispatch-logs")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, systemPromptFileName(phase, shardIndex, subStage)), content, "utf-8")
}

/**
 * 落盘 workOrder 到 artifactsDir/dispatch-logs/。
 *
 * 注：dispatch 主路径已改为落完整 system prompt（persistSystemPrompt）；workOrder 落盘保留为
 * 通用工具 + 旧 run 兼容（system.transform 兜底读 .workOrder.md）。新 run 不再单独写 workOrder 文件。
 */
export function persistWorkOrder(
  artifactsDir: string,
  phase: string,
  shardIndex: number | undefined,
  content: string,
  subStage?: string,
): void {
  const dir = join(artifactsDir, "dispatch-logs")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, workOrderFileName(phase, shardIndex, subStage)), content, "utf-8")
}

/** 读取已持久化的完整 system prompt（system.transform 注入用）。缺失返回 null。 */
export function readPersistedSystemPrompt(
  artifactsDir: string,
  phase: string,
  shardIndex: number | undefined,
  subStage?: string,
): string | null {
  const p = join(artifactsDir, "dispatch-logs", systemPromptFileName(phase, shardIndex, subStage))
  if (!existsSync(p)) return null
  try {
    return readFileSync(p, "utf-8")
  } catch {
    return null
  }
}

/** 读取已持久化的 workOrder（system.transform 旧 run 兜底用——旧 run 只有 .workOrder.md，无 .systemPrompt.md）。缺失返回 null。 */
export function readPersistedWorkOrder(
  artifactsDir: string,
  phase: string,
  shardIndex: number | undefined,
  subStage?: string,
): string | null {
  const p = join(artifactsDir, "dispatch-logs", workOrderFileName(phase, shardIndex, subStage))
  if (!existsSync(p)) return null
  try {
    return readFileSync(p, "utf-8")
  } catch {
    return null
  }
}
