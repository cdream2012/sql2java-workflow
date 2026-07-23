/**
 * Watchdog 容错监控 — 检测 worker 卡死/编排者卡死/crash 并干预。
 *
 * 判定依据：统一用 session.status 事件（busy=在运行，idle=没在运行），不判有效性。
 * - worker busy 持续 > workerTimeoutMs → abort（卡在 tool/LLM 挂起）
 * - worker idle 持续 > idleConfirmMs → abort（杀透防恢复重复执行）
 * - 编排者 idle + 无活跃 worker + run running + 超时 → promptAsync 唤醒调 resume
 *   （无次数上限：只有人工终止 manualStopRunId 或 run 运行完毕才停止唤醒）
 * - 编排者 session 持续消失 > orchestratorMissingThresholdMs → 提示手动 /sql2java resume
 * - 上下文使用率监控：step-finish 的 input tokens / 模型 max context 逐档升级告警——
 *   首破 contextWarnPct → WARN 并沉默，继续每 +10% 一档（70/80/90…）再 WARN；
 *   跌破 contextWarnPct 重置。只观测告警不干预；compact 仍保留作兜底。
 * - 上下文采样：定时（contextSampleIntervalMs）把各 session 上下文占用写
 *   .workflow-artifacts/<runId>/logs/context-samples.jsonl，供离线画曲线（含 phase）。
 *
 * 重派/恢复交给现有机制（worker abort 后编排者自动重派 via advance 门控）。
 * watchdog 唯一主动副作用：client.session.abort / client.session.promptAsync。
 *
 * 详见 plan: watchdog 容错监控正式实现。
 */

import { appendFile, appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

// ── 配置 ─────────────────────────────────────────────────────────────────────

export interface WatchdogConfig {
  enabled: boolean
  workerTimeoutMs: number                  // worker busy 运行总时长超时
  orchestratorIdleTimeoutMs: number        // 编排者 idle（无活跃 worker）超时
  idleConfirmMs: number                    // 持续 idle 确认"没在运行"的宽限期
  crashDetectionIntervalMs: number         // crash 检测轮询间隔
  orchestratorMissingThresholdMs: number   // session 持续消失判 crash 阈值
  nudgeCooldownMs: number                  // 两次唤醒最小间隔（仅限频，不设上限）
  phaseOverrides?: Record<string, { workerTimeoutMs?: number }>
  contextWarnPct: number                   // 上下文使用率告警阈值（占模型 max context 比例），超则 WARN
  modelContextLimitFallback: number        // 拿不到模型 limit 时的兜底 token 数
  contextSampleIntervalMs: number          // 上下文采样间隔（ms），0=关；写 context-samples.jsonl 供画曲线
}

const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  enabled: true,
  workerTimeoutMs: 120 * 60_000,           // 2 小时（容纳 AST 分析/编译/测试，及大模型访问较差环境的慢响应）
  orchestratorIdleTimeoutMs: 5 * 60_000,   // 5min（= opencode provider 单次请求超时上限：编排者 idle+无活跃 worker 持续超过它，即排除"在等单次 LLM 请求"，确认全卡死。正常流程编排者 idle 间隙秒级，不受影响）
  idleConfirmMs: 10 * 60_000,              // 10min（慢环境 LLM 请求间隔拉长，给更多持续 idle 宽限再确认）
  crashDetectionIntervalMs: 60_000,        // 60s
  orchestratorMissingThresholdMs: 3 * 60_000, // 3min（避 session.list 抖动）
  nudgeCooldownMs: 60_000,
  phaseOverrides: {},
  contextWarnPct: 0.6,                     // 60%（用户期望：到模型最大上下文 60% 提示；compact 仍保留作兜底）
  modelContextLimitFallback: 200_000,      // 解析不到模型 limit 时兜底
  contextSampleIntervalMs: 60_000,         // 60s 采样一次写 jsonl，供离线画上下文曲线；0=关
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
  lastContextTokens?: number               // 最近一次 step-finish 的 input tokens（≈当前上下文长度）
  contextWarnTier?: number                 // 已告警的最高档位（0=未告警；逐档升级 60→70→80…，每 +10% 一档）
  modelLimit?: number                      // 该 session 模型的 max context（懒解析，解析前 undefined）
  modelResolveFailed?: boolean             // 模型 limit 解析失败标记（避反复重试）
  modelResolving?: boolean                 // 模型 limit 解析中（避 step-finish 高频触发并发重入）
}

const sessionMap = new Map<string, WatchdogEntry>()
let cfg: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG
let apiClient: any = null
let engineRef: any = null                  // WorkflowEngine 实例（只用 status(runId)）
let stuckTimer: ReturnType<typeof setInterval> | undefined
let crashTimer: ReturnType<typeof setInterval> | undefined
let sampleTimer: ReturnType<typeof setInterval> | undefined
let started = false

let currentRunId: string | undefined
let manualStopRunId: string | undefined  // 人工终止（ESC session.interrupt）标记的 run，watchdog 不唤醒编排者

// 模型 providers 缓存（全局，跨 run 复用；providers 不随 run 变化）。
// 用于把 session 的 modelID → Model.limit.context 解析出 max context。
let providersCache: { providers: any[]; default: Record<string, string> } | null = null
let providersFetching: Promise<typeof providersCache> | null = null

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
  if (cfg.contextSampleIntervalMs > 0) {
    sampleTimer = setInterval(() => safeRun(sampleContext), cfg.contextSampleIntervalMs)
  }
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

// ── 上下文使用率监控（由 event hook 的 step-finish 调用）──────────────────────

/**
 * 处理 step-finish 的 input tokens：≈ 当前 session 上下文长度。
 * 逐档升级告警：首破 contextWarnPct → WARN，沉默；继续每 +10% 一档（70/80/90…）再 WARN。
 * 跌破 contextWarnPct 才重置（允许新一轮攀升）。compact 机制仍保留作兜底，本监控只观测+告警。
 */
export function handleSessionTokens(sid: string, inputTokens: number): void {
  if (!started || !sid) return
  const e = sessionMap.get(sid)
  if (!e) return
  if (typeof inputTokens !== "number" || inputTokens <= 0) return
  e.lastContextTokens = inputTokens
  // 模型 limit 懒解析（异步，不阻塞本调用）；解析前 checkContextThreshold 会跳过
  if (e.modelLimit === undefined && !e.modelResolveFailed && !e.modelResolving) {
    safeRun(() => resolveModelLimit(sid))
  }
  checkContextThreshold(sid)
}

/** 拉取 providers 全量缓存（跨 session/run 复用）。 */
async function ensureProviders(): Promise<any[]> {
  if (providersCache) return providersCache.providers
  if (!providersFetching) {
    providersFetching = (async () => {
      const resp = await apiClient?.config?.providers?.()
      const data = resp?.data ?? resp
      providersCache = { providers: data?.providers ?? [], default: data?.default ?? {} }
      return providersCache
    })()
  }
  const r = await providersFetching
  return r?.providers ?? []
}

/**
 * 解析 session 模型的 max context：取该 session 最近一条 assistant message 的
 * modelID/providerID → 在 providers 缓存里查 Model.limit.context。失败用兜底。
 */
async function resolveModelLimit(sid: string): Promise<void> {
  const e = sessionMap.get(sid)
  if (!e || e.modelLimit !== undefined || e.modelResolving) return
  e.modelResolving = true
  try {
    const providers = await ensureProviders()
    const resp = await apiClient?.session?.messages?.({ path: { id: sid } })
    const msgs = resp?.data ?? resp ?? []
    let modelID: string | undefined
    let providerID: string | undefined
    for (let i = msgs.length - 1; i >= 0; i--) {
      const info = msgs[i]?.info
      if (info?.role === "assistant" && info.modelID) {
        modelID = info.modelID
        providerID = info.providerID
        break
      }
    }
    let limit: number | undefined
    if (modelID) {
      for (const p of providers) {
        if (providerID && p.id !== providerID) continue
        const m = p?.models?.[modelID]
        if (typeof m?.limit?.context === "number") { limit = m.limit.context; break }
      }
    }
    if (limit) {
      e.modelLimit = limit
    } else {
      e.modelLimit = cfg.modelContextLimitFallback
      wlog("INFO",
        `session ${sid} 模型 limit 未解析到(modelID=${modelID ?? "?"} provider=${providerID ?? "?"})，用兜底 ${e.modelLimit}`)
    }
    checkContextThreshold(sid)
  } catch (err: any) {
    e.modelResolveFailed = true
    e.modelLimit = cfg.modelContextLimitFallback
    wlog("WARN", `解析模型 limit 失败 sid=${sid}: ${err?.message ?? err}，用兜底 ${e.modelLimit}`)
    checkContextThreshold(sid)
  } finally {
    e.modelResolving = false
  }
}

function checkContextThreshold(sid: string): void {
  const e = sessionMap.get(sid)
  if (!e || e.modelLimit === undefined) return
  const tokens = e.lastContextTokens
  if (tokens === undefined) return
  const pct = tokens / e.modelLimit
  const floor = cfg.contextWarnPct
  // 逐档升级：首档 = floor，之后每 +0.10 一档。pct < floor → 0（未告警）。
  // 1e-9 容差吸收浮点误差（0.7-0.6=0.0999… 否则 Math.floor 会少一档）。
  const tier = pct < floor ? 0 : floor + Math.floor((pct - floor) / 0.10 + 1e-9) * 0.10
  const lastTier = e.contextWarnTier ?? 0
  if (tier > lastTier) {
    e.contextWarnTier = tier
    const hint = e.role === "orchestrator"
      ? "。编排者上下文膨胀可能拖慢/拖垮长 run；如需释放可手动开新 session 跑 /sql2java resume（run 断点已持久化于 .workflow-artifacts/<runId>/run.json）"
      : ""
    wlog("WARN",
      `${e.role} session ${sid} 上下文使用率 ${(pct * 100).toFixed(1)}% (${tokens}/${e.modelLimit} tokens) ≥ ${tier === floor ? "首档" : "新档"} ${(tier * 100).toFixed(0)}%（逐档升级：60→70→80…，每 +10% 一档；跌破 ${(floor * 100).toFixed(0)}% 重置）${hint}`)
  } else if (pct < floor && lastTier > 0) {
    // 跌破首档（如 compact 压回）→ 重置，允许新一轮攀升逐档告警
    e.contextWarnTier = 0
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
    // (f) 冷却期内 → 跳过（仅限频，不设唤醒上限）
    if (e.lastNudgeAt && Date.now() - e.lastNudgeAt < cfg.nudgeCooldownMs) continue
    nudgeOrchestrator(sid, e.runId)
  }
}

function nudgeOrchestrator(sid: string, runId: string): void {
  const e = sessionMap.get(sid)
  if (!e) return
  e.nudgeCount++
  e.lastNudgeAt = Date.now()
  wlog("WARN", `orchestrator ${sid} idle 无活跃 worker，第 ${e.nudgeCount} 次唤醒调 resume (runId=${runId})`)
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

// ── 上下文采样（定时写 context-samples.jsonl，供离线画曲线）────────────────────

/**
 * 定时扫描所有登记 session，把 {ts,runId,sid,role,phase,tokens,modelLimit,pct} 追加到
 * .workflow-artifacts/<runId>/logs/context-samples.jsonl。异步追加，失败静默（不影响 run）。
 * phase：worker 取自身 e.phase；orchestrator 取 run 当前推进阶段 engine.status(runId).currentPhase。
 */
async function sampleContext(): Promise<void> {
  if (!currentRunId) return
  const ts = new Date().toISOString()
  const lines: string[] = []
  for (const [sid, e] of sessionMap) {
    if (e.runId !== currentRunId) continue  // 仅采当前 run 的 session，避残留 entry 混入
    if (e.lastContextTokens === undefined || e.modelLimit === undefined) continue
    const phase = e.role === "worker"
      ? e.phase
      : engineRef?.status?.(e.runId)?.currentPhase
    const pct = e.lastContextTokens / e.modelLimit
    lines.push(JSON.stringify({
      ts,
      runId: e.runId,
      sid,
      role: e.role,
      phase: phase ?? null,
      tokens: e.lastContextTokens,
      modelLimit: e.modelLimit,
      pct: Number(pct.toFixed(4)),
    }))
  }
  if (!lines.length) return
  const path = join(".workflow-artifacts", currentRunId, "logs", "context-samples.jsonl")
  try {
    mkdirSync(dirname(path), { recursive: true })
    await appendFile(path, lines.join("\n") + "\n", "utf-8")
  } catch {
    // 采样落盘失败不影响 run，静默（避免每个 tick 刷错误日志）
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
