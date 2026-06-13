/**
 * engine-cross-schema.test.ts — 跨 Schema 校验集成测试
 *
 * 测试 validateCrossSchema / validateInventoryIndexConsistency。
 * 验证不同阶段 artifact 间的引用一致性。
 *
 * TODO: 补充具体输入 → 预期输出
 */

import { describe, it, expect } from "vitest"
import { WorkflowEngine } from "@workflow/engine-core"
import { SQL2JAVA_WORKFLOW } from "@workflow/workflow-definitions"
import { createEngineWithTempDir, writeArtifact } from "../helpers/engine-factory"
import {
  makeInventoryIndex, makeAnalysisMeta, makePlan, makeTranslation,
  makeReviewSummary, makeVerifySummary, makeDedup,
} from "../helpers/artifact-factory"

describe("engine-cross-schema", () => {
  describe("inventory ↔ analysis 包名一致性", () => {
    it("analysis 引用的包在 inventory 中存在", () => {
      // TODO: 写 inventory-index.json + analysis-meta.json
      // 调用 validateCrossSchema 或 validateInventoryIndexConsistency
      // 预期：无错误
    })

    it("analysis 引用了 inventory 不存在的包 → 报错", () => {
      // TODO: analysis-meta 有 "GHOST_PKG"，inventory 只有 "CORE_PKG"
      // 预期：返回错误信息包含 "GHOST_PKG"
    })
  })

  describe("plan mapping 覆盖率", () => {
    it("plan 的 packageMappings 覆盖所有 inventory 包", () => {
      // TODO
    })

    it("plan 缺少某包的 mapping → 报错", () => {
      // TODO
    })
  })

  describe("translation 覆盖率", () => {
    it("每个 inventory 包都有对应的 translation", () => {
      // TODO
    })

    it("translation 引用了不存在的包 → 报错", () => {
      // TODO
    })
  })

  describe("review/verify 包名引用", () => {
    it("reviewSummary.packageResults 的包名在 inventory 中", () => {
      // TODO
    })

    it("verifySummary.packageResults 的包名在 inventory 中", () => {
      // TODO
    })
  })

  describe("dedup affectedPackages 引用", () => {
    it("dedup 的 packageChanges 引用的包在 inventory 中", () => {
      // TODO
    })
  })
})
