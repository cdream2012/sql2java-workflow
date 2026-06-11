/**
 * Workflow Logger — 将日志写入文件，避免 console.warn/error 泄漏到 opencode 输入框。
 *
 * 日志路径：.workflow-artifacts/${runId}/logs/workflow.log
 * runId 未初始化前，所有 info/warn/error 静默忽略。
 */

import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const ARTIFACT_DIR = ".workflow-artifacts"

export interface WorkflowLogger {
  info(tag: string, msg: string): void
  warn(tag: string, msg: string): void
  error(tag: string, msg: string): void
}

// ── 单例状态 ──────────────────────────────────────────

let logFilePath: string | null = null

class FileLogger implements WorkflowLogger {
  private write(level: string, tag: string, msg: string): void {
    if (!logFilePath) return // runId 未初始化，静默忽略
    const ts = new Date().toISOString()
    const line = `[${ts}] [${level}] ${tag} ${msg}\n`
    try {
      appendFileSync(logFilePath, line, "utf-8")
    } catch {
      // 写日志失败时不再 console，避免死循环
    }
  }

  info(tag: string, msg: string): void {
    this.write("INFO", tag, msg)
  }

  warn(tag: string, msg: string): void {
    this.write("WARN", tag, msg)
  }

  error(tag: string, msg: string): void {
    this.write("ERROR", tag, msg)
  }
}

const instance = new FileLogger()

// ── 公开 API ──────────────────────────────────────────

/** 初始化 logger：创建 logs 目录，设置日志文件路径。 */
export function initLogger(runId: string): void {
  const logsDir = join(ARTIFACT_DIR, runId, "logs")
  mkdirSync(logsDir, { recursive: true })
  logFilePath = join(logsDir, "workflow.log")
}

/** 获取 logger 单例。未初始化时 info/warn/error 静默忽略。 */
export function getLogger(): WorkflowLogger {
  return instance
}

/** 清理单例（run 结束时调用）。 */
export function destroyLogger(): void {
  logFilePath = null
}
