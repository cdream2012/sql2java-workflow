/**
 * artifact-schemas.test.ts — Zod Schema 校验测试
 */

import { describe, it, expect } from "vitest"
import {
  InventoryIndexSchema,
  InventorySchema,
  ScaffoldSchema,
  TranslationSchema,
  ReviewSchema,
  ProjectReviewSchema,
  ReviewSummarySchema,
  VerifySchema,
  VerifySummarySchema,
  DedupSchema,
  FixArtifactSchema,
  PackageArtifactSchema,
  SubprogramArtifactSchema,
  TableArtifactSchema,
  getSchemaForPhase,
  getPerPackageSchema,
  getSummarySchema,
  getArtifactFilename,
} from "@workflow/artifact-schemas"
import {
  makeInventoryIndex, makeInventory,
  makeScaffold, makeTranslation,
  makeReviewSummary, makeVerifySummary, makeDedup, makeFixArtifact,
} from "../helpers/artifact-factory"

// ═══════════════════════════════════════════════════════════════
// Schema 有效数据通过校验
// ═══════════════════════════════════════════════════════════════

describe("Schema 有效数据通过校验", () => {
  it("InventoryIndexSchema 通过", () => {
    expect(InventoryIndexSchema.safeParse(makeInventoryIndex()).success).toBe(true)
  })

  it("InventorySchema 通过", () => {
    const data = {
      sourcePath: "/test",
      packageNames: ["CORE_PKG"],
      tableNames: ["T_ITEM"],
      triggers: [],
      views: [],
      sequences: [],
    }
    expect(InventorySchema.safeParse(data).success).toBe(true)
  })

  it("ScaffoldSchema 通过（含 targetProject + packageMappings，Stage C 合并 plan）", () => {
    const data = {
      targetProject: {
        groupId: "com.example",
        javaVersion: "1.8",
        springBootVersion: "2.7.x",
      },
      packageMappings: [
        { plsqlSchema: "MFG", plsqlPackage: "PKG_A", components: [{ role: "service-impl" }, { role: "mapper" }] },
      ],
      projectRoot: "/abs/path/generated/item-service",
      structure: {
        directories: ["src/main/java/mapper", "src/main/java/service"],
        pomXml: "pom.xml",
      },
      generated: {
        entities: [],
        procClassNames: [{ plsqlSchema: "MFG", plsqlPackage: "PKG_A", refName: "CREATE_A", className: "CreateA" }],
        constants: [{ file: "src/main/java/constant/PkgAConstant.java", plsqlSchema: "MFG", plsqlPackage: "PKG_A" }],
        stateDtos: [{ file: "src/main/java/dto/PkgAStateDTO.java", plsqlSchema: "MFG", plsqlPackage: "PKG_A" }],
        commonClasses: [],
      },
      conventions: "Standard Spring Boot conventions",
    }
    expect(ScaffoldSchema.safeParse(data).success).toBe(true)
  })

  it("TranslationSchema 通过", () => {
    const data = {
      packageName: "CORE_PKG",
      status: "completed",
      completedSubprograms: ["GET_ITEM"],
      totalSubprograms: 1,
      files: [{ path: "service/impl/ItemServiceImpl.java", role: "service" }],
      decisions: [],
      todos: [],
    }
    expect(TranslationSchema.safeParse(data).success).toBe(true)
  })

  it("TranslationSchema 含 subprogramMethods 通过", () => {
    const data = {
      packageName: "CORE_PKG",
      status: "completed",
      completedSubprograms: ["GET_ITEM"],
      totalSubprograms: 1,
      files: [{ path: "service/impl/ItemServiceImpl.java", role: "service" }],
      decisions: [],
      todos: [],
      subprogramMethods: [
        { plsqlName: "get_item", javaClass: "com.example.item.service.ItemService", javaMethod: "getItem", javaFile: "service/ItemService.java" },
      ],
    }
    expect(TranslationSchema.safeParse(data).success).toBe(true)
  })

  it("TranslationSchema 重载子程序 refName 唯一（__序号区分，重复 plsqlName 被拒）", () => {
    const data = {
      packageName: "CORE_PKG",
      status: "completed",
      completedSubprograms: ["get_param__1", "get_param__2"],
      totalSubprograms: 2,
      files: [],
      decisions: [],
      todos: [],
      subprogramMethods: [
        { plsqlName: "get_param__1", javaClass: "com.example.item.service.ItemService", javaMethod: "getParamById" },
        { plsqlName: "get_param__2", javaClass: "com.example.item.service.ItemService", javaMethod: "getParamByName" },
      ],
    }
    // 合法：两个不同 refName → 通过
    expect(TranslationSchema.safeParse(data).success).toBe(true)

    // 非法：重复 plsqlName（裸名撞重载的典型错误）→ 被拒
    const dup = { ...data, subprogramMethods: [
      { plsqlName: "get_param", javaClass: "X", javaMethod: "a" },
      { plsqlName: "get_param", javaClass: "X", javaMethod: "b" },
    ] }
    const parsed = TranslationSchema.safeParse(dup)
    expect(parsed.success).toBe(false)
  })

  it("ReviewSchema 通过 (passed=true, mustFix=[])", () => {
    const data = {
      packageName: "CORE_PKG",
      passed: true,
      overallScore: 85,
      procedureReviews: [],
      mustFix: [],
      suggestions: [],
      todoRemainingCount: 0,
    }
    expect(ReviewSchema.safeParse(data).success).toBe(true)
  })

  it("ReviewSchema 通过 (passed=false, mustFix 非空)", () => {
    const data = {
      packageName: "CORE_PKG",
      passed: false,
      overallScore: 50,
      procedureReviews: [],
      mustFix: [{ file: "ItemAggregate.java", line: 10, issue: "Missing null check" }],
      suggestions: [],
      todoRemainingCount: 1,
    }
    expect(ReviewSchema.safeParse(data).success).toBe(true)
  })

  it("ProjectReviewSchema 通过（packages[] 覆盖多包，每包过 ReviewSchema refine）", () => {
    const data = {
      packages: [
        { packageName: "PKG_A", passed: true, overallScore: 90, procedureReviews: [], mustFix: [], suggestions: [], todoRemainingCount: 0 },
        { packageName: "PKG_B", passed: false, overallScore: 55, procedureReviews: [], mustFix: [{ file: "B.java", line: 3, issue: "x" }], suggestions: [], todoRemainingCount: 1 },
      ],
    }
    expect(ProjectReviewSchema.safeParse(data).success).toBe(true)
  })

  it("ProjectReviewSchema 拒绝 passed=true 但 mustFix 非空的包条目（per-package refine 生效）", () => {
    const data = {
      packages: [
        { packageName: "PKG_A", passed: true, overallScore: 90, procedureReviews: [], mustFix: [{ file: "A.java", line: 1, issue: "x" }], suggestions: [], todoRemainingCount: 0 },
      ],
    }
    expect(ProjectReviewSchema.safeParse(data).success).toBe(false)
  })

  it("ReviewSummarySchema 通过 (allPassed=true)", () => {
    expect(ReviewSummarySchema.safeParse(makeReviewSummary()).success).toBe(true)
  })

  it("ReviewSummarySchema 通过 (allPassed=false)", () => {
    const data = {
      allPassed: false,
      packageResults: [
        { packageName: "CORE_PKG", passed: false, score: 50, mustFixCount: 2 },
      ],
      totalMustFix: 2,
      totalTodosRemaining: 1,
    }
    expect(ReviewSummarySchema.safeParse(data).success).toBe(true)
  })

  it("VerifySchema 通过 (passed=true, mustFix=[])", () => {
    const data = {
      packageName: "CORE_PKG",
      passed: true,
      mybatisValidation: { mapperXmlValid: true, statementIdsMatch: true },
      todoRemainingCount: 0,
      mustFix: [],
    }
    expect(VerifySchema.safeParse(data).success).toBe(true)
  })

  it("VerifySummarySchema 通过 (allPassed=true)", () => {
    const data = {
      allPassed: true,
      compilation: { success: true, errors: [] },
      packageResults: [{ packageName: "CORE_PKG", passed: true, mybatisValid: true }],
      testExecution: { executed: true, testFiles: ["ItemServiceTest.java"] },
      totalTodosRemaining: 0,
      coverage: { executed: false, passed: true, lineThreshold: 0.9, branchThreshold: 0.75, packageCoverage: [] },
    }
    expect(VerifySummarySchema.safeParse(data).success).toBe(true)
  })

  it("VerifySummarySchema 通过 (compilation failed, errors 非空)", () => {
    const data = {
      allPassed: false,
      compilation: {
        success: false,
        errors: [{ file: "ItemAggregate.java", line: 10, message: "cannot find symbol" }],
      },
      packageResults: [{ packageName: "CORE_PKG", passed: false, mybatisValid: false }],
      testExecution: { executed: false, testFiles: [] },
      totalTodosRemaining: 1,
      coverage: { executed: false, passed: true, lineThreshold: 0.9, branchThreshold: 0.75, packageCoverage: [] },
    }
    expect(VerifySummarySchema.safeParse(data).success).toBe(true)
  })

  it("DedupSchema 通过", () => {
    expect(DedupSchema.safeParse(makeDedup()).success).toBe(true)
  })

  it("FixArtifactSchema 通过", () => {
    expect(FixArtifactSchema.safeParse(makeFixArtifact()).success).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// 工厂默认产出符合 Schema（防止工厂与 schema 漂移，P9）
// ═══════════════════════════════════════════════════════════════

describe("工厂默认产出符合 Schema", () => {
  it("makeScaffold 默认值通过 ScaffoldSchema", () => {
    expect(ScaffoldSchema.safeParse(makeScaffold()).success).toBe(true)
  })
  it("makeTranslation 默认值通过 TranslationSchema", () => {
    expect(TranslationSchema.safeParse(makeTranslation()).success).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// Schema 无效数据被拒绝
// ═══════════════════════════════════════════════════════════════

describe("Schema 无效数据被拒绝", () => {
  it("InventoryIndexSchema 缺少必填字段失败", () => {
    const result = InventoryIndexSchema.safeParse({ sourcePath: "/test" })
    expect(result.success).toBe(false)
  })

  it("InventoryIndexSchema subprograms 缺失失败（新形状顶层必填）", () => {
    const data = makeInventoryIndex()
    delete (data as any).subprograms
    expect(InventoryIndexSchema.safeParse(data).success).toBe(false)
  })

  it("ReviewSchema passed=true + mustFix 非空 → refine 失败", () => {
    const data = {
      packageName: "CORE_PKG",
      passed: true,
      overallScore: 80,
      procedureReviews: [],
      mustFix: [{ file: "a.java", issue: "bug" }],
      suggestions: [],
      todoRemainingCount: 0,
    }
    const result = ReviewSchema.safeParse(data)
    expect(result.success).toBe(false)
  })

  it("ReviewSchema passed=false + mustFix 空 → refine 失败", () => {
    const data = {
      packageName: "CORE_PKG",
      passed: false,
      overallScore: 40,
      procedureReviews: [],
      mustFix: [],
      suggestions: [],
      todoRemainingCount: 1,
    }
    const result = ReviewSchema.safeParse(data)
    expect(result.success).toBe(false)
  })

  it("ReviewSummarySchema allPassed 与 packageResults 矛盾 → refine 失败", () => {
    const data = {
      allPassed: true,
      packageResults: [
        { packageName: "CORE_PKG", passed: false, score: 50, mustFixCount: 2 },
      ],
      totalMustFix: 2,
      totalTodosRemaining: 1,
    }
    const result = ReviewSummarySchema.safeParse(data)
    expect(result.success).toBe(false)
  })

  it("VerifySummarySchema compilation failed 但 errors=[] → 通过（已放松：空数组视为已声明）", () => {
    const data = {
      allPassed: false,
      compilation: { success: false, errors: [] },
      packageResults: [{ packageName: "CORE_PKG", passed: false, mybatisValid: false }],
      testExecution: { executed: false, testFiles: [] },
      totalTodosRemaining: 1,
      coverage: { executed: false, passed: true, lineThreshold: 0.9, branchThreshold: 0.75, packageCoverage: [] },
    }
    const result = VerifySummarySchema.safeParse(data)
    expect(result.success).toBe(true)
  })

  it("VerifySummarySchema compilation failed 且 errors 完全缺失 → refine 失败", () => {
    const data = {
      allPassed: false,
      compilation: { success: false },
      packageResults: [{ packageName: "CORE_PKG", passed: false, mybatisValid: false }],
      testExecution: { executed: false, testFiles: [] },
      totalTodosRemaining: 1,
    }
    const result = VerifySummarySchema.safeParse(data)
    expect(result.success).toBe(false)
  })

  it("FixArtifactSchema fixedPackages 为空 → refine 失败", () => {
    const result = FixArtifactSchema.safeParse({ fixedPackages: [] })
    expect(result.success).toBe(false)
  })

  it("ScaffoldSchema 不含 rules/typeMappings/conventions（Stage B/C 移至注入的 Java 代码规约；passthrough 容忍旧残留）", () => {
    const base = makeScaffold()
    expect(ScaffoldSchema.safeParse(base).success).toBe(true)
    // 旧 plan/scaffold 残留 rules/typeMappings/conventions 时由 passthrough 容忍
    const legacy = { ...base, rules: { namingConvention: "snake_case" }, typeMappings: {}, conventions: "" }
    expect(ScaffoldSchema.safeParse(legacy).success).toBe(true)
    // targetProject 不含 artifactId（Stage A/C：artifactId 来自 run-context）
    expect(base.targetProject).not.toHaveProperty("artifactId")
  })

  it("ScaffoldSchema 拒绝无 components 的 packageMapping（components 空数组）", () => {
    const data = makeScaffold({
      packageMappings: [
        // 仅 plsqlPackage，无任何组件（无 javaPackage）
        { plsqlPackage: "PKG_A", components: [] },
      ],
    })
    const result = ScaffoldSchema.safeParse(data)
    expect(result.success).toBe(false)
  })

  it("ScaffoldSchema 接受纯常量包映射（仅常量持有角色组件，无业务角色/mapper）", () => {
    const data = makeScaffold({
      packageMappings: [
        // 纯常量包：无子程序，只映射常量持有角色
        { plsqlSchema: "", plsqlPackage: "PKG_CONST", components: [{ role: "constant" }] },
      ],
    })
    const result = ScaffoldSchema.safeParse(data)
    expect(result.success).toBe(true)
    expect(result.success && result.data.packageMappings[0].components[0].role).toBe("constant")
  })
})

// ═══════════════════════════════════════════════════════════════
// Schema 查找函数
// ═══════════════════════════════════════════════════════════════

describe("getArtifactFilename", () => {
  it("analyze → analyze（无顶层文件，回退 phase 名）", () => {
    expect(getArtifactFilename("analyze")).toBe("analyze")
  })

  it("translate → translation", () => {
    expect(getArtifactFilename("translate")).toBe("translation")
  })

  it("inventory → inventory", () => {
    expect(getArtifactFilename("inventory")).toBe("inventory")
  })

  it("plan 阶段已移除（Stage C），回退 phase 名", () => {
    // plan 不再在 PHASE_FILENAME_MAP，回退返回 phase 名本身
    expect(getArtifactFilename("plan")).toBe("plan")
  })

  it("未知 phase 返回原值", () => {
    expect(getArtifactFilename("custom-phase")).toBe("custom-phase")
  })
})

describe("getSchemaForPhase", () => {
  const knownPhases = ["inventory", "scaffold", "dedup", "review", "fix"]

  it("已知阶段都返回非 null schema", () => {
    for (const phase of knownPhases) {
      expect(getSchemaForPhase(phase), `getSchemaForPhase("${phase}") should not be null`).not.toBeNull()
    }
  })

  it("plan 阶段已移除（Stage C）→ 返回 null", () => {
    expect(getSchemaForPhase("plan")).toBeNull()
  })

  it("review 返回 ProjectReviewSchema（项目级单文件）", () => {
    expect(getSchemaForPhase("review")).not.toBeNull()
  })

  it("未知阶段返回 null", () => {
    expect(getSchemaForPhase("unknown")).toBeNull()
  })
})

describe("getPerPackageSchema", () => {
  it("translate 返回 TranslationSchema", () => {
    expect(getPerPackageSchema("translate")).not.toBeNull()
  })

  it("review 不再 per-package（改项目级单文件 review.json，packages[]）", () => {
    // review 改项目级单次审核：reviewer 写一个 artifactsDir/review.json（packages[] 覆盖全部包），
    // 由 getSchemaForPhase("review") = ProjectReviewSchema 校验；不再有 per-package review.json。
    expect(getPerPackageSchema("review")).toBeNull()
  })

  it("verify 不再 per-package（动态结果落 verify-summary.json）", () => {
    // verify 静态检查归 review，动态检查（mvn + 归因）由 generateVerifySummary 代码聚合到
    // verify-summary.json；不再产 per-package verify.json。
    expect(getPerPackageSchema("verify")).toBeNull()
  })

  it("非 per-package 阶段返回 null", () => {
    expect(getPerPackageSchema("inventory")).toBeNull()
    expect(getPerPackageSchema("plan")).toBeNull()
  })
})

describe("getSummarySchema", () => {
  it("review-summary 返回非 null", () => {
    expect(getSummarySchema("review-summary")).not.toBeNull()
  })

  it("verify-summary 返回非 null", () => {
    expect(getSummarySchema("verify-summary")).not.toBeNull()
  })

  it("非 summary 阶段返回 null", () => {
    expect(getSummarySchema("review")).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════
// 类型放松：Zod 不再因合理变体拒绝 LLM 产出
// ═══════════════════════════════════════════════════════════════

describe("类型放松 — 合理 LLM 变体不再被拒", () => {
  it("TableArtifactSchema: defaultValue=null → 通过", () => {
    const data = {
      name: "T",
      ddlFile: "t.sql",
      columns: [{ name: "C", plsqlType: "NUM", nullable: true, isPrimaryKey: false, defaultValue: null }],
    }
    expect(TableArtifactSchema.safeParse(data).success).toBe(true)
  })

  it("VerifySummarySchema: errors=[] + success=false → 通过", () => {
    const data = {
      allPassed: false,
      compilation: { success: false, errors: [] },
      packageResults: [{ packageName: "X", passed: false, mybatisValid: false }],
      testExecution: { executed: false, testFiles: [] },
      totalTodosRemaining: 0,
      coverage: { executed: false, passed: true, lineThreshold: 0.9, branchThreshold: 0.75, packageCoverage: [] },
    }
    expect(VerifySummarySchema.safeParse(data).success).toBe(true)
  })

  it("TranslationSchema: files.role 非枚举值 → 通过", () => {
    const data = {
      packageName: "X",
      status: "completed",
      completedSubprograms: ["A"],
      totalSubprograms: 1,
      files: [{ path: "a.java", role: "entity" }],
      decisions: [],
      todos: [],
    }
    expect(TranslationSchema.safeParse(data).success).toBe(true)
  })

  it("TranslationSchema: status 非枚举值 → 通过", () => {
    const data = {
      packageName: "X",
      status: "in_progress",
      completedSubprograms: [],
      totalSubprograms: 5,
      files: [],
      decisions: [],
      todos: [],
    }
    expect(TranslationSchema.safeParse(data).success).toBe(true)
  })

  it("TranslationSchema: totalSubprograms 为字符串 → 通过（coerce）", () => {
    const data = {
      packageName: "X",
      status: "completed",
      completedSubprograms: ["A"],
      totalSubprograms: "5",
      files: [],
      decisions: [],
      todos: [],
    }
    expect(TranslationSchema.safeParse(data).success).toBe(true)
  })

  it("ReviewSchema: checks.category 非枚举值 → 通过", () => {
    const data = {
      packageName: "X",
      passed: true,
      overallScore: 85,
      procedureReviews: [{ procedure: "P", checks: [{ category: "custom-check", passed: true, detail: "ok", severity: "info" }] }],
      mustFix: [],
      suggestions: [],
      todoRemainingCount: 0,
    }
    expect(ReviewSchema.safeParse(data).success).toBe(true)
  })

  it("ReviewSchema: suggestions 含对象 → 通过", () => {
    const data = {
      packageName: "X",
      passed: true,
      overallScore: 85,
      mustFix: [],
      suggestions: [{ severity: "info", issue: "minor issue" }],
      todoRemainingCount: 0,
    }
    expect(ReviewSchema.safeParse(data).success).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════
// 大小写 normalize — ciEnum 自动纠正 LLM 大小写变体
// ═══════════════════════════════════════════════════════════════

describe("大小写 normalize — ciEnum 自动纠正 LLM 大小写变体", () => {
  // ── scannerUsed (ciEnumLower) ────────────────────────────

  it("InventoryIndexSchema: scannerUsed 'AST' normalize 为 'ast'", () => {
    const base = makeInventoryIndex()
    base.scannerUsed = "AST" as any
    const result = InventoryIndexSchema.safeParse(base)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.scannerUsed).toBe("ast")
    }
  })

  // ── triggers (ciEnumLower) ───────────────────────────────

  it("InventorySchema: triggers 大小写变体 normalize 为小写", () => {
    const data = {
      sourcePath: "/test",
      packageNames: ["PKG"],
      tableNames: [],
      triggers: [{
        name: "TRG",
        timing: "BEFORE",
        level: "ROW",
        targetTable: "T",
        events: ["INSERT", "UPDATE"],
        sourceFile: "trg.sql",
        lineRange: [1, 10] as [number, number],
      }],
      views: [],
      sequences: [],
    }
    const result = InventorySchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.triggers[0].timing).toBe("before")
      expect(result.data.triggers[0].level).toBe("row")
      expect(result.data.triggers[0].events).toEqual(["insert", "update"])
    }
  })

  // ── mode 在 SubprogramArtifactSchema.parameters（原 InventorySchema.standaloneProcedures.direction）──

  it("SubprogramArtifactSchema: parameters mode 'out' normalize 为 'OUT'", () => {
    const data = {
      name: "SP",
      type: "PROCEDURE",
      belongToPackage: "PKG",
      overloadIndex: null,
      isPrivate: false,
      headerLocation: null,
      bodyLocation: { absolutePath: "sp.sql", lineRange: [1, 10] as [number, number] },
      parameters: [{ name: "X", type: "NUMBER", mode: "out", defaultExpression: null }],
      returnType: null,
      loc: 10,
      directCalls: [],
    }
    const result = SubprogramArtifactSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.parameters[0].mode).toBe("OUT")
    }
  })
})
