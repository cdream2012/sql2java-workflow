/**
 * Artifact Factory — 构建有效 artifact JSON 对象，供测试使用
 *
 * 每个函数返回对应阶段的有效 artifact 数据。
 * 可通过展开 + 覆写的方式生成变体。
 *
 * 注意：本文件被 vitest（tests/ts）与 tsx（case.config.ts）双重加载，故对 .opencode
 * 用相对路径引入（@workflow 别名只在 vitest 生效）。
 */

import { safeWriteFile } from "../../../.opencode/workflow/cross-platform"
import { join } from "node:path"

// ── Inventory Index ──────────────────────────────────────────

export function makeInventoryIndex(overrides: Record<string, unknown> = {}) {
  return {
    sourcePath: "/test/source",
    scannedAt: "2026-06-01T00:00:00.000Z",
    scannerUsed: "regex" as const,
    warnings: [] as string[],
    packages: [
      {
        packageName: "CORE_PKG",
        absolutePaths: ["pkg/core_pkg.pks", "pkg/core_pkg.pkb"],
        headerPath: "pkg/core_pkg.pks",
        bodyPath: "pkg/core_pkg.pkb",
        constants: [], variables: [], exceptions: [], types: [],
        functions: ["GET_ITEM"],
        procedures: ["SET_ITEM"],
        estimatedLoc: 200,
      },
    ],
    subprograms: [
      {
        name: "GET_ITEM", type: "FUNCTION", belongToPackage: "CORE_PKG",
        overloadIndex: null, isPrivate: false,
        headerLocation: { absolutePath: "pkg/core_pkg.pks", lineRange: [10, 10] },
        bodyLocation: { absolutePath: "pkg/core_pkg.pkb", lineRange: [10, 50] },
        parameters: [{ name: "P_ID", type: "NUMBER", mode: "IN", defaultExpression: null }],
        returnType: "t_item%ROWTYPE", loc: 41,
        directCalls: [], packageRefs: [],
      },
      {
        name: "SET_ITEM", type: "PROCEDURE", belongToPackage: "CORE_PKG",
        overloadIndex: null, isPrivate: false,
        headerLocation: { absolutePath: "pkg/core_pkg.pks", lineRange: [52, 52] },
        bodyLocation: { absolutePath: "pkg/core_pkg.pkb", lineRange: [52, 90] },
        parameters: [], returnType: null, loc: 39,
        directCalls: [], packageRefs: [],
      },
    ],
    tables: [{ name: "ITEMS", ddlFile: "schema/tables.sql", columns: [] }],
    triggers: [{ name: "TRG_ITEM_AUD", sourceFile: "trigger/trg_item_audit.sql" }],
    views: [],
    sequences: [{ name: "SEQ_ITEM_ID", ddlFile: "schema/sequences.sql" }],
    standaloneProcedures: [],
    ...overrides,
  }
}

// ── Inventory (full) ─────────────────────────────────────────

export function makeInventory(overrides: Record<string, unknown> = {}) {
  return {
    sourcePath: "/test/source",
    packageNames: ["CORE_PKG", "BASE_PKG"],
    tables: [{ name: "ITEMS", ddlFile: "schema/tables.sql", columns: [{ name: "ITEM_ID", plsqlType: "NUMBER", nullable: false, isPrimaryKey: true }] }],
    standaloneProcedures: [],
    triggers: [],
    views: [],
    sequences: [],
    ...overrides,
  }
}

// ── Package Artifact（逐包 inventory，新形状）─────────────────

/** packages/{PKG}.json — 对齐 PackageArtifactSchema（redesign 后取代旧 inventory-packages/{PKG}.json） */
export function makePackageArtifact(overrides: Record<string, unknown> = {}) {
  return {
    packageName: "CORE_PKG",
    absolutePaths: ["pkg/core_pkg.pks", "pkg/core_pkg.pkb"],
    headerPath: "pkg/core_pkg.pks",
    bodyPath: "pkg/core_pkg.pkb",
    constants: [],
    variables: [],
    exceptions: [],
    types: [],
    functions: [],
    procedures: ["GET_ITEM"],
    estimatedLoc: 40,
    complexity: { score: 3, patterns: [], riskLevel: "low" as const },
    ...overrides,
  }
}

/** subprograms/{PKG.METHOD}.json — 对齐 SubprogramArtifactSchema（含 directCalls/packageRefs） */
export function makeSubprogramArtifact(overrides: Record<string, unknown> = {}) {
  return {
    name: "GET_ITEM",
    type: "FUNCTION" as const,
    belongToPackage: "CORE_PKG",
    overloadIndex: null,
    isPrivate: false,
    headerLocation: null,
    bodyLocation: { absolutePath: "pkg/core_pkg.pkb", lineRange: [10, 50] as [number, number] },
    parameters: [{ name: "P_ID", type: "NUMBER", mode: "IN" as const, defaultExpression: null }],
    returnType: "VARCHAR2",
    loc: 40,
    directCalls: [] as Array<{ package: string; name: string; line: number; kind: "function" | "procedure" }>,
    packageRefs: [] as Array<{ package: string; name: string; line: number }>,
    ...overrides,
  }
}

// ── Scaffold ─────────────────────────────────────────────────

/** scaffold.json — 对齐 ScaffoldSchema（Stage C：吸收原 plan 的 targetProject + packageMappings） */
export function makeScaffold(overrides: Record<string, unknown> = {}) {
  return {
    targetProject: {
      groupId: "com.example",
      javaVersion: "1.8",
      springBootVersion: "2.7.x",
    },
    packageMappings: [
      {
        plsqlSchema: "",
        plsqlPackage: "CORE_PKG",
        components: [
          { role: "service" },
          { role: "service-impl" },
          { role: "mapper" },
        ],
      },
    ],
    coverageExcludes: ["exception/", "entity/", "config/", "util/", "constant/", "dto/"],
    projectRoot: "/abs/path/generated/item-service",
    structure: {
      directories: ["src/main/java/mapper", "src/main/java/service"],
      pomXml: "pom.xml",
    },
    generated: {
      entities: [],
      procClassNames: [{ plsqlSchema: "", plsqlPackage: "CORE_PKG", refName: "GET_ITEM", className: "GetItem" }],
      constants: [{ file: "src/main/java/constant/CorePkgConstant.java", plsqlSchema: "", plsqlPackage: "CORE_PKG" }],
      stateDtos: [{ file: "src/main/java/dto/CorePkgStateDTO.java", plsqlSchema: "", plsqlPackage: "CORE_PKG" }],
      commonClasses: [
        { file: "src/main/java/exception/BusinessException.java", purpose: "业务异常基类" },
        { file: "src/main/java/exception/DataNotFoundException.java", purpose: "数据未找到" },
      ],
      commonModules: {
        classes: [
          { file: "src/main/java/exception/BusinessException.java", purpose: "业务异常基类", category: "exception" },
          { file: "src/main/java/exception/DataNotFoundException.java", purpose: "数据未找到", category: "exception" },
        ],
        directories: ["src/main/java/exception"],
      },
    },
    conventions: "Standard conventions",
    ...overrides,
  }
}

// ── Analysis Package（逐包）──────────────────────────────────

/** analysis-packages/{PKG}.json — 对齐 AnalysisPackageSchema */
export function makeAnalysisPackage(overrides: Record<string, unknown> = {}) {
  return {
    packageName: "CORE_PKG",
    subprograms: [
      {
        name: "GET_ITEM",
        blocks: [{ type: "sql-statement" as const, plsqlLine: 12, description: "SELECT INTO 查询", dependencies: [] }],
        variables: [],
        cursors: [],
        exceptionHandlers: [],
        translationNotes: ["按 id 查询"],
      },
    ],
    ...overrides,
  }
}

// ── Translation (per package) ────────────────────────────────

/** translations/{PKG}/translation.json — 对齐 TranslationSchema（含 subprogramMethods） */
export function makeTranslation(overrides: Record<string, unknown> = {}) {
  return {
    packageName: "CORE_PKG",
    status: "completed" as const,
    completedSubprograms: ["GET_ITEM"],
    totalSubprograms: 1,
    files: [{ path: "src/main/java/com/example/item/core/domain/aggregate/ItemAggregate.java", role: "aggregate" }],
    decisions: [],
    todos: [],
    subprogramMethods: [
      { plsqlName: "GET_ITEM", javaClass: "com.example.item.core.access.ItemAccessIntf", javaMethod: "getItem" },
    ],
    ...overrides,
  }
}

// ── Review Summary ───────────────────────────────────────────

export function makeReviewSummary(overrides: Record<string, unknown> = {}) {
  return {
    allPassed: true,
    packageResults: [
      { packageName: "CORE_PKG", passed: true, score: 85, mustFixCount: 0 },
    ],
    totalMustFix: 0,
    totalTodosRemaining: 0,
    ...overrides,
  }
}

// ── Verify Summary ───────────────────────────────────────────

export function makeVerifySummary(overrides: Record<string, unknown> = {}) {
  return {
    allPassed: true,
    compilation: { success: true, errors: [] },
    packageResults: [
      { packageName: "CORE_PKG", passed: true, mybatisValid: true },
    ],
    // testExecution 为必填（VerifySummarySchema BREAKING），含必填 testFiles[]
    testExecution: {
      executed: true,
      totalTests: 1,
      passedTests: 1,
      failedTests: 0,
      testFiles: ["src/test/java/com/example/item/ItemServiceTest.java"],
    },
    totalTodosRemaining: 0,
    // coverage 为必填（VerifySummarySchema）；默认跳过（executed=false, passed=true 不阻断）
    coverage: {
      executed: false,
      passed: true,
      lineThreshold: 0.9,
      branchThreshold: 0.75,
      packageCoverage: [],
    },
    ...overrides,
  }
}

// ── Dedup ────────────────────────────────────────────────────

export function makeDedup(overrides: Record<string, unknown> = {}) {
  return {
    scanStats: {
      totalPackages: 1,
      totalFilesScanned: 10,
      duplicateGroupsFound: 0,
    },
    extractedModules: [],
    packageChanges: [],
    metrics: {
      filesExtracted: 0,
      filesModified: 0,
      linesRemoved: 0,
      linesAdded: 0,
    },
    ...overrides,
  }
}

// ── Fix Artifact ─────────────────────────────────────────────

export function makeFixArtifact(overrides: Record<string, unknown> = {}) {
  return {
    fixedPackages: ["CORE_PKG"],
    ...overrides,
  }
}

// ── 写入 artifact JSON（跨平台原子写） ───────────────────────

/**
 * 将 artifact 数据以 JSON 写入目录（跨平台原子写：tmp→rename，避免半写状态）。
 * 供 case.config.ts 的 prepareArtifacts 复用，替代裸 writeFileSync(JSON.stringify(...))。
 */
export function writeArtifactJson(dir: string, filename: string, data: unknown): void {
  safeWriteFile(join(dir, filename), JSON.stringify(data))
}
