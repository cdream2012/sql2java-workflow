/**
 * llm-cases-fixture-shape.test.ts — L2 case fixture 迁移到新形状后的结构验证
 *
 * 3 个 L2 case（translate-exception-mapping / translate-cross-package-call /
 * review-detect-swallowed-exception）原 fixture 用旧形状（inventory-packages/ +
 * dependency-graph.json，redesign 已废弃）。迁移到新形状（packages/ + subprograms/，
 * 依赖图按需推导）后，用 prepareExecutionPoint（真实 engine-core 推进、不调 opencode）
 * 验证各 case 的 prepareArtifacts 能跨过 inventory→…→目标 phase 全部边界校验不被拒绝。
 *
 * 仅验证 fixture 形状被引擎接受（advance 不 reject）。case 的最终断言（LLM 产出）仍需
 * `bash tests/llm/run-tests.sh` 真跑 agent 验证——非本测试覆盖。
 */
import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { prepareExecutionPoint, RUN_ID } from "../../llm/harness"
import type { CaseConfig } from "../../llm/harness"
import excCase from "../../llm/cases/translate-exception-mapping/case.config"
import xpkgCase from "../../llm/cases/translate-cross-package-call/case.config"
import reviewCase from "../../llm/cases/review-detect-swallowed-exception/case.config"

const CASES: CaseConfig[] = [excCase, xpkgCase, reviewCase]

describe.skip("L2 case fixture 新形状迁移（prepareExecutionPoint 推进不被拒绝）", () => {
  // A-2 sharded translate 重构后 prepareExecutionPoint 停在 translate 无法到 review/目标 phase；
  // 待补 sharded 测试基建后恢复。
  for (const c of CASES) {
    it(`${c.name}: prepareArtifacts 跨过边界校验，停在 ${c.phase}`, () => {
      const workDir = mkdtempSync(join(tmpdir(), "l2-shape-"))
      try {
        const prepared = prepareExecutionPoint({
          workDir,
          phase: c.phase,
          sourcePath: c.sourcePath,
          prepareArtifacts: c.prepareArtifacts,
        })
        const runJson = JSON.parse(
          readFileSync(join(prepared.artifactsDir, "run.json"), "utf-8"),
        ) as { currentPhase: string; status: string }
        expect(runJson.currentPhase, `${c.name} 应停在 ${c.phase}`).toBe(c.phase)
        expect(runJson.status).toBe("running")
      } finally {
        rmSync(workDir, { recursive: true, force: true })
      }
    }, 60000)
  }
})
