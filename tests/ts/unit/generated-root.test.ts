/**
 * generated-root.test.ts — Java 项目输出根目录（generated/<artifactId>/）claim 行为测试
 *
 * 新设计（去 fallback）：projectRoot 永远 = generated/<artifactId>/，无 runId 后缀。
 * claimGeneratedRoot 靠 .sql2java-run-id marker 区分：
 *   - 同 run 续跑（marker===runId）→ 保留半成品
 *   - 换 run（marker≠runId / 无 marker 遗留）→ 清空 base 重建（避免旧 run 产物残留混存）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { resolveGeneratedRoot, claimGeneratedRoot, generatedRootFor } from "@plugins/workflow-engine"

const MARKER = ".sql2java-run-id"
let repo: string

beforeEach(() => { repo = mkdtempSync(join(tmpdir(), "gen-root-")) })
afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

describe("resolveGeneratedRoot / claimGeneratedRoot", () => {
  it("目录不存在 → claim 建 base + 写本 run 标记；resolve 永远返回 base", () => {
    const root = claimGeneratedRoot("run-A", "mfg-erp", repo)
    expect(root).toBe(join(repo, "generated", "mfg-erp"))
    expect(existsSync(join(root, MARKER))).toBe(true)
    expect(readFileSync(join(root, MARKER), "utf-8")).toBe("run-A")
    // resolve 永远 base，不因状态变化翻转
    expect(resolveGeneratedRoot("run-A", "mfg-erp", repo)).toBe(join(repo, "generated", "mfg-erp"))
    expect(resolveGeneratedRoot("run-B", "mfg-erp", repo)).toBe(join(repo, "generated", "mfg-erp"))
  })

  it("同 runId resume → 复用 base，不换目录、不清空、不覆盖标记、保留产物", () => {
    const rootA = claimGeneratedRoot("run-A", "mfg-erp", repo)
    writeFileSync(join(rootA, "pom.xml"), "first attempt", "utf-8")  // 首次 scaffold 半成品
    // 续跑（同 runId）
    const rootA2 = claimGeneratedRoot("run-A", "mfg-erp", repo)
    expect(rootA2).toBe(join(repo, "generated", "mfg-erp"))  // 仍 base
    expect(readFileSync(join(rootA2, MARKER), "utf-8")).toBe("run-A")  // 标记不变
    expect(existsSync(join(rootA2, "pom.xml"))).toBe(true)  // 半成品保留
    expect(readFileSync(join(rootA2, "pom.xml"), "utf-8")).toBe("first attempt")
  })

  it("不同 runId 撞同一 artifactId → 复用 base 但清空旧 run 产物 + 覆写 marker（无 fallback 目录）", () => {
    const rootA = claimGeneratedRoot("run-A", "mfg-erp", repo)
    writeFileSync(join(rootA, "stale.java"), "old com.example leftover", "utf-8")
    // run-B claim：marker=run-A ≠ run-B → 清空重建
    const claimedB = claimGeneratedRoot("run-B", "mfg-erp", repo)
    expect(claimedB).toBe(join(repo, "generated", "mfg-erp"))  // 仍 base，无 -run-B 后缀
    expect(readFileSync(join(claimedB, MARKER), "utf-8")).toBe("run-B")
    expect(existsSync(join(claimedB, "stale.java"))).toBe(false)  // 旧 run 产物已清空
    expect(existsSync(join(repo, "generated", "mfg-erp-run-B"))).toBe(false)  // 无 fallback 目录
  })

  it("无 marker 的遗留目录（旧 run 残留 / agent 自建）→ 清空重建，写本 run marker", () => {
    const legacy = join(repo, "generated", "mfg-erp")
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, "stale.java"), "leftover", "utf-8")
    const root = claimGeneratedRoot("run-A", "mfg-erp", repo)
    expect(root).toBe(join(repo, "generated", "mfg-erp"))  // base，无 fallback
    expect(existsSync(join(root, MARKER))).toBe(true)
    expect(readFileSync(join(root, MARKER), "utf-8")).toBe("run-A")
    expect(existsSync(join(root, "stale.java"))).toBe(false)  // 遗留已清
  })

  it("generatedRootFor 永远返回 base（不读 metadata，跨 session 确定性）", () => {
    const run = { runId: "run-X", metadata: { generatedRoot: "/should/be/ignored" } as Record<string, unknown> }
    expect(generatedRootFor(run, "mfg-erp", repo)).toBe(join(repo, "generated", "mfg-erp"))
    // metadata.generatedRoot 不再生效（去 fallback 后路径仅由 artifactId 决定）
    const runNoMeta = { runId: "run-Y", metadata: {} }
    expect(generatedRootFor(runNoMeta, "mfg-erp", repo)).toBe(join(repo, "generated", "mfg-erp"))
  })
})
