/**
 * Watchdog 容错监控 — 检测 worker 卡死/编排者卡死/crash 并干预。
 *
 * 判定依据：统一用 session.status 事件（busy=在运行，idle=没在运行），不判有效性。
 * - worker busy 持续 > workerTimeoutMs → abort（卡在 tool/LLM 挂起）
 * - worker idle 持续 > idleConfirmMs → abort（杀透防恢复重复执行）
 * - 编排者 idle + 无活跃 worker + run running + 超时 → promptAsync 唤醒调 resume
 * - 编排者 session 持续消失 > orchestratorMissingThresholdMs → 提示手动 /sql2java resume
 *
 * 重派/恢复交给现有机制（worker abort 后编排者自动重派 via advance 门控）。
 * watchdog 唯一主动副作用：client.session.abort / client.session.promptAsync。
 *
 * 详见 plan: watchdog 容错监控正式实现。
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

// ── 配置 ─────────────────────────────────────────────────────────────────────

export interface WatchdogConfig {
  enabled: boolean
  workerTimeoutMs: number                  // worker busy 运行总时长超时
  orchestratorIdleTimeoutMs: number        // 编排者 idle（无活跃 worker）超时
  idleConfirmMs: number                    // 持续 idle 确认"没在运行"的宽限期
  crashDetectionIntervalMs: number         // crash 检测轮询间隔
  orchestratorMissingThresholdMs: number   // session 持续消失判 crash 阈值
  maxNudgesPerIdle: number                 // 同一 idle 周期最多唤醒次数
  nudgeCooldownMs: number                  // 两次唤醒最小间隔
  phaseOverrides?: Record<string, { workerTimeoutMs?: number }>
}

const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  enabled: true,
  workerTimeoutMs: 120 * 60_000,           // 2 小时（容纳 AST 分析/编译/测试，及大模型访问较差环境的慢响应）
  orchestratorIdleTimeoutMs: 20 * 60_000,  // 20min（慢环境下 worker 登记/状态事件延迟更常见，放宽唤醒阈值）
  idleConfirmMs: 10 * 60_000,              // 10min（慢环境 LLM 请求间隔拉长，给更多持续 idle 宽限再确认）
  crashDetectionIntervalMs: 60_000,        // 60s
  orchestratorMissingThresholdMs: 3 * 60_000, // 3min（避 session.list 抖动）
  maxNudgesPerIdle: 3,
  nudgeCooldownMs: 60_000,
  phaseOverrides: {},
}

/** 解析 watchdog 配置。当前用默认 + 可选 phase 覆盖；未来可从 run.metadata 读。 */
export function resolveWatchdogConfig(
  phaseOverrides?: Record<string, { workerTimeoutMs?: number }>,
): WatchdogConfig {
  return { ...DEFAULT_WATCHDOG_CONFIG, phaseOverrides: phaseOverrides ?? {} }
}

// ── 模块级状态 ────────────────────────────────────────────────────────────────

interface WatchdogEntry {
  role: "worker" | "orchestrator"
  runId: string
  phase?: string                           // worker 必填
  startTime: number
  lastStatus: "busy" | "idle" | "unknown"
  lastStatusAt: number
  timeoutTimer?: ReturnType<typeof setTimeout>  // worker：busy 超时 / idle 确认（按 lastStatus 切换）
  nudgeCount: number                       // 编排者唤醒限频
  lastPhase?: string                       // 编排者：上次 currentPhase，变化时重置 nudgeCount
  lastNudgeAt?: number
  missingSince?: number                    // crash 检测：session 持续消失起点
  crashAlerted?: boolean                   // crash 告警去重
}

const sessionMap = new Map<string, WatchdogEntry>()
let cfg: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG
let apiClient: any = null
let engineRef: any = null                  // WorkflowEngine 实例（只用 status(runId)）
let stuckTimer: ReturnType<typeof setInterval> | undefined
let crashTimer: ReturnType<typeof setInterval> | undefined
let started = false

let currentRunId: string | undefined
let manualStopRunId: string | undefined  // 人工终止（ESC session.interrupt）标记的 run，watchdog 不唤醒编排者

function wdLogPath(runId: string): string {
  return join(".workflow-artifacts", runId, "logs", "watchdog.log")
}

// ── 日志（runId 创建前缓存，创建后 flush 到 per-run logs/watchdog.log）──────

// runId 创建前的日志缓存：runId 设置后 flush 到 per-run logs/watchdog.log。
// 不再生成全局 _watchdog.log（runId 创建前不落盘，符合「runId 创建后才打印日志」）。
let pendingLogs: string[] = []

function wlog(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const line = `[${new Date().toISOString()}] [${level}] [watchdog] ${msg}\n`
  const runId = currentRunId
  if (runId) {
    try {
      mkdirSync(dirname(wdLogPath(runId)), { recursive: true })
      if (pendingLogs.length) {
        appendFileSync(wdLogPath(runId), pendingLogs.join(""), "utf-8")
        pendingLogs = []
      }
      appendFileSync(wdLogPath(runId), line, "utf-8")
      return
    } catch { /* per-run 写失败：缓存待下次，不写全局文件 */ }
  }
  pendingLogs.push(line)
}

// ── 生命周期 ──────────────────────────────────────────────────────────────────

export function initWatchdog(config: WatchdogConfig, client: any, engine: any): void {
  cfg = config
  apiClient = client
  engineRef = engine
  if (!config.enabled) { wlog("INFO", "watchdog 已禁用 (enabled=false)"); started = false; return }
  if (!client) { wlog("INFO", "client 未注入，watchdog 降级为 no-op"); started = false; return }
  if (started) return
  started = true
  const stuckInterval = Math.max(
    Math.min(cfg.orchestratorIdleTimeoutMs, cfg.idleConfirmMs) / 2,
    30_000,
  )
  stuckTimer = setInterval(() => safeRun(checkOrchestratorStuck), stuckInterval)
  crashTimer = setInterval(() => safeRun(checkOrchestratorCrash), cfg.crashDetectionIntervalMs)
  wlog("INFO",
    `启动 workerTimeout=${cfg.workerTimeoutMs}ms idleTimeout=${cfg.orchestratorIdleTimeoutMs}ms idleConfirm=${cfg.idleConfirmMs}ms`)
}

// ── 登记（由 chat.params hook 调用）──────────────────────────────────────────

export function registerWorker(
  sid: string,
  ctx: { runId: string; phase: string } | null,
): void {
  if (!started || !sid || !ctx) return
  const existing = sessionMap.get(sid)
  if (existing && existing.role === "worker") {
    if (existing.lastStatus === "idle") {
      // idle 后重新 chat.params = 新 busy 段（恢复/重派），重启 busy 超时 timer
      if (existing.timeoutTimer) clearTimeout(existing.timeoutTimer)
      existing.timeoutTimer = setTimeout(() => onWorkerTimeout(sid), workerTimeoutFor(existing.phase))
      existing.lastStatus = "busy"
      wlog("INFO", `worker 恢复 busy sid=${sid} phase=${existing.phase}，重启 timer`)
    }
    // 同 busy 段多次 LLM 请求：不重置 timer（避免长任务永不超时），只刷新活动时间
    existing.lastStatusAt = Date.now()
    return
  }
  if (!currentRunId) currentRunId = ctx.runId
  // 新 worker 登记 = 上一轮 worker 正常完成（编排者 advance 才会派新 worker，串行调度）。
  // 清理同 run 已 idle 的旧 worker entry（正常完成，不 abort——不再监控已完成的 worker）。
  // 只有编排者没派新 worker（卡死）时，旧 worker 才会 idleConfirmMs 后 abort。
  for (const [oldSid, oldE] of sessionMap) {
    if (oldE.role === "worker" && oldE.runId === ctx.runId && oldSid !== sid && oldE.lastStatus === "idle") {
      if (oldE.timeoutTimer) clearTimeout(oldE.timeoutTimer)
      sessionMap.delete(oldSid)
      wlog("INFO", `worker ${oldSid} 正常完成清理（phase=${oldE.phase}），新 worker ${sid} 登记`)
    }
  }
  const timeoutMs = workerTimeoutFor(ctx.phase)
  const entry: WatchdogEntry = {
    role: "worker",
    runId: ctx.runId,
    phase: ctx.phase,
    startTime: Date.now(),
    lastStatus: "busy",
    lastStatusAt: Date.now(),
    nudgeCount: 0,
  }
  entry.timeoutTimer = setTimeout(() => onWorkerTimeout(sid), timeoutMs)
  sessionMap.set(sid, entry)
  wlog("INFO", `worker 登记 sid=${sid} phase=${ctx.phase} run=${ctx.runId} timeout=${timeoutMs}ms`)
}

export function registerOrchestrator(sid: string, runId?: string): void {
  if (!started || !sid) return
  const existing = sessionMap.get(sid)
  if (existing && existing.role === "orchestrator") return  // 幂等
  if (!runId) return
  if (!currentRunId) currentRunId = runId
  sessionMap.set(sid, {
    role: "orchestrator",
    runId,
    startTime: Date.now(),
    lastStatus: "unknown",
    lastStatusAt: Date.now(),
    nudgeCount: 0,
  })
  wlog("INFO", `orchestrator 登记 sid=${sid} run=${runId}`)
}

/**
 * 标记当前 run 人工终止（ESC session.interrupt）——watchdog 不再唤醒编排者。
 * 编排者重新 busy（用户 resume/继续输入）时自动清除标记，恢复监控。
 * 用于区分：人工终止（ESC，不干预）vs 程序异常卡死（无标记，watchdog 干预）。
 */
/**
 * session.error 处理：编排者 session 被 ESC 中断（MessageAbortedError）= 人工终止。
 * watchdog 不 abort 编排者（只 abort worker），所以编排者的 MessageAbortedError 一定是人工 ESC。
 * worker 的 MessageAbortedError 可能是 watchdog 自身 abort 触发，不标记。
 * 据此区分人工终止（ESC，不干预）vs 程序异常（无此信号，watchdog 干预）。
 */
export function handleSessionError(sid: string, errorName: string): void {
  if (!started || !sid) return
  if (errorName !== "MessageAbortedError") return
  const e = sessionMap.get(sid)
  if (!e || e.role !== "orchestrator") return  // 只编排者被中断才算人工 ESC
  if (currentRunId && manualStopRunId !== currentRunId) {
    manualStopRunId = currentRunId
    wlog("INFO", `run ${currentRunId} 人工终止标记（编排者被 ESC 中断: MessageAbortedError），watchdog 不再唤醒；编排者重新 busy 时自动清除`)
  }
}

// ── session.status 处理（由 event hook 调用）──────────────────────────────────

export function handleSessionStatus(sid: string, status: any): void {
  if (!started || !sid) return
  const st = typeof status === "string" ? status : status?.type
  if (st !== "busy" && st !== "idle") return  // retry 等忽略
  const e = sessionMap.get(sid)
  if (!e) return
  const now = Date.now()

  if (st === "busy") {
    if (e.lastStatus === "busy") return  // 降噪：重复 busy
    e.lastStatus = "busy"
    e.lastStatusAt = now
    if (e.role === "worker") {
      // worker 从 idle 恢复（新 busy 段）：重启 busy 超时 timer
      if (e.timeoutTimer) clearTimeout(e.timeoutTimer)
      e.timeoutTimer = setTimeout(() => onWorkerTimeout(sid), workerTimeoutFor(e.phase))
    } else if (manualStopRunId === e.runId) {
      manualStopRunId = undefined  // 编排者重新 busy = 用户 resume/继续，清人工终止标记
    }
    // orchestrator busy 不重置 nudgeCount（在 currentPhase 推进时重置，防反复 busy/idle 无限唤醒）
    return
  }

  // idle
  if (e.lastStatus === "idle") return  // 降噪：重复 idle
  e.lastStatus = "idle"
  e.lastStatusAt = now
  if (e.role === "worker") {
    // worker idle：切到 idle 确认 timer（idleConfirmMs 后 abort 杀透，防恢复重复执行）
    if (e.timeoutTimer) clearTimeout(e.timeoutTimer)
    e.timeoutTimer = setTimeout(() => onWorkerTimeout(sid), cfg.idleConfirmMs)
    wlog("INFO", `worker idle sid=${sid} phase=${e.phase}，启动 idle 确认 ${cfg.idleConfirmMs}ms（期间若无新 worker 登记则 abort）`)
  }
}

// ── worker 超时/ idle 确认 → abort ────────────────────────────────────────────

function onWorkerTimeout(sid: string): void {
  const e = sessionMap.get(sid)
  if (!e || e.role !== "worker") return  // 失效校验：已清除或换主
  if (e.runId === manualStopRunId) {
    // 人工终止期间不 abort worker（避免触发编排者 busy 清除 manualStop），清 entry
    if (e.timeoutTimer) clearTimeout(e.timeoutTimer)
    sessionMap.delete(sid)
    return
  }
  const reason = e.lastStatus === "idle"
    ? `idle 确认超时(${cfg.idleConfirmMs}ms)`
    : `busy 超时(${workerTimeoutFor(e.phase)}ms)`
  wlog("WARN", `worker ${sid} ${reason} phase=${e.phase} run=${e.runId} → abort`)
  try {
    apiClient?.session?.abort?.({ path: { id: sid } })
  } catch (err: any) {
    wlog("WARN", `abort 失败 ${sid}: ${err?.message ?? err}`)
  }
  if (e.timeoutTimer) clearTimeout(e.timeoutTimer)
  sessionMap.delete(sid)
  // 不主动 retry——编排者收到 abort 后自动重派（实验2 验证）
}

// ── 编排者卡死判定（setInterval 扫描）────────────────────────────────────────

function workerTimeoutFor(phase?: string): number {
  const ov = phase ? cfg.phaseOverrides?.[phase]?.workerTimeoutMs : undefined
  return ov ?? cfg.workerTimeoutMs
}

/** 该 run 是否有活跃 worker（busy，或 idle 未超 idleConfirmMs）。编排者等 worker 时为 true。 */
function hasActiveWorker(runId: string): boolean {
  const now = Date.now()
  for (const e of sessionMap.values()) {
    if (e.role !== "worker" || e.runId !== runId) continue
    if (e.lastStatus === "busy") return true
    if (e.lastStatus === "idle" && now - e.lastStatusAt < cfg.idleConfirmMs) return true
  }
  return false
}

function checkOrchestratorStuck(): void {
  for (const [sid, e] of sessionMap) {
    if (e.role !== "orchestrator") continue
    const run = engineRef?.status?.(e.runId)
    if (!run || run.status !== "running") {
      if (e.runId === currentRunId) currentRunId = undefined
      sessionMap.delete(sid)  // run 结束，清理 orchestrator entry 避积累
      continue
    }
    if (!run.currentPhase) continue
    if (e.runId === manualStopRunId) continue  // 人工终止（ESC interrupt），不唤醒
    // 阶段推进 → 重置唤醒计数（编排者真推进了，新一轮）
    if (e.lastPhase === undefined) e.lastPhase = run.currentPhase
    else if (run.currentPhase !== e.lastPhase) {
      e.lastPhase = run.currentPhase
      e.nudgeCount = 0
    }
    // (c) 有活跃 worker → 正常等 worker，不干预
    if (hasActiveWorker(e.runId)) continue
    // (d) 编排者非 idle → busy 靠 provider 5min 兜底，跳过
    if (e.lastStatus !== "idle") continue
    // (e) idle 未超时 → 跳过
    const idleFor = Date.now() - e.lastStatusAt
    if (idleFor < cfg.orchestratorIdleTimeoutMs) continue
    // (f) 唤醒达上限 → 建议人工介入
    if (e.nudgeCount >= cfg.maxNudgesPerIdle) {
      wlog("WARN", `orchestrator ${sid} 唤醒达上限 ${e.nudgeCount}，run=${e.runId} 建议人工介入`)
      continue
    }
    // (g) 冷却期内 → 跳过
    if (e.lastNudgeAt && Date.now() - e.lastNudgeAt < cfg.nudgeCooldownMs) continue
    nudgeOrchestrator(sid, e.runId)
  }
}

function nudgeOrchestrator(sid: string, runId: string): void {
  const e = sessionMap.get(sid)
  if (!e) return
  e.nudgeCount++
  e.lastNudgeAt = Date.now()
  wlog("WARN", `orchestrator ${sid} idle 无活跃 worker，唤醒调 resume (runId=${runId})`)
  try {
    apiClient?.session?.promptAsync?.({
      path: { id: sid },
      body: {
        parts: [{
          type: "text",
          text: `工作流 watchdog 检测到编排者长时间空闲，请调用 /sql2java resume (runId=${runId}) 从断点继续。`,
        }],
      },
    })
  } catch (err: any) {
    wlog("WARN", `promptAsync 失败 ${sid}: ${err?.message ?? err}`)
  }
}

// ── crash 检测（setInterval 轮询 session.list）────────────────────────────────

async function checkOrchestratorCrash(): Promise<void> {
  for (const [sid, e] of sessionMap) {
    if (e.role !== "orchestrator") continue
    const run = engineRef?.status?.(e.runId)
    if (!run || run.status !== "running") {
      if (e.crashAlerted) e.crashAlerted = false
      if (e.runId === currentRunId) currentRunId = undefined
      sessionMap.delete(sid)
      continue
    }
    let sessions: any[] = []
    try {
      const resp = await apiClient?.session?.list?.()
      sessions = resp?.data ?? resp ?? []
    } catch (err: any) {
      wlog("WARN", `session.list 失败: ${err?.message ?? err}`)
      continue
    }
    const exists = sessions.some((s: any) => s.id === sid || s.sessionID === sid)
    if (exists) {
      e.missingSince = undefined
      e.crashAlerted = false
      continue
    }
    if (!e.missingSince) e.missingSince = Date.now()
    const missingFor = Date.now() - e.missingSince
    if (missingFor >= cfg.orchestratorMissingThresholdMs && !e.crashAlerted) {
      e.crashAlerted = true
      wlog("ERROR",
        `编排者 session ${sid} 持续消失 ${Math.round(missingFor / 1000)}s，run ${e.runId} 仍 running → 疑似 crash。` +
        `请手动执行 /sql2java resume 恢复（断点已持久化于 .workflow-artifacts/${e.runId}/run.json）`)
    }
  }
}

// ── 工具 ───────────────────────────────────────────────────────────────────────

function safeRun(fn: () => void | Promise<void>): void {
  try {
    Promise.resolve(fn()).catch((err: any) => wlog("WARN", `scan 失败: ${err?.message ?? err}`))
  } catch (err: any) {
    wlog("WARN", `scan 同步异常: ${err?.message ?? err}`)
  }
}
