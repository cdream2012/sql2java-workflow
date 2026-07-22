/**
 * Schema Hint Enrichments — Zod 无法自动提取的校验规则补充数据
 *
 * 五个来源：
 *   1. REFINE_CONSTRAINTS  — Zod .refine() 的业务规则（toJSONSchema 无法导出）
 *   2. NON_ZOD_VALIDATION_RULES — validateArtifactOnDisk() 中的额外引擎级校验
 *   3. QUALITY_GATE_HINTS  — L3 确定性质量门控阈值
 *   4. CROSS_SCHEMA_HINTS  — 跨 Schema 校验规则（仅 needsCrossSchemaValidation=true 的阶段）
 *   5. COMMON_PITFALLS     — 常见被拒原因（枚举大小写、跨字段约束、格式陷阱等）
 *
 * 维护约定：
 *   - REFINE_CONSTRAINTS 的 message 应与 artifact-schemas.ts 中 .refine() 的 message 一致
 *   - QUALITY_GATE_HINTS 的阈值应与 engine-core.ts 的 QUALITY_GATE_THRESHOLDS 一致
 *   - CROSS_SCHEMA_HINTS 的 key 应与 workflow-definitions.ts 中 needsCrossSchemaValidation=true 的 phase 一致
 *   - COMMON_PITFALLS 中提到的枚举值必须与 artifact-schemas.ts 中的 Zod enum 一致
 *   - 测试文件 schema-hint-enrichments.test.ts 会自动检测漂移
 */

import { QUALITY_GATE_THRESHOLDS } from "./engine-core"

// ═══════════════════════════════════════════════════════════════
// 1. Refine 约束 — Zod .refine() 中的业务规则
// ═══════════════════════════════════════════════════════════════

/**
 * 每个 phase 的 refine 约束描述。
 * key = phase 名（per-package schema 的 phase 用对应的顶层 phase 名）。
 *
 * 与 artifact-schemas.ts 中 .refine() 的 message 保持一致，
 * 测试会校验 message 子串匹配。
 */
export const REFINE_CONSTRAINTS: Record<string, string[]> = {
  inventory: [
    "packages/{PKG}.json 的 procedures/functions 仅为名字数组（详情在 subprograms/{PKG.METHOD}.json）；有子程序的包应有 bodyPath（procedure 实现体在 body 中）",
  ],
  translate: [
    "subprogramMethods.plsqlName 必须唯一（重载子程序用 {name}__序号 区分，禁用裸名重复）",
  ],
  review: [
    "passed 与 mustFix 必须一致：passed=true 时 mustFix 必须为空，passed=false 时 mustFix 必须非空",
    "allPassed 应与 packageResults 一致：allPassed=true 当且仅当所有 packageResults[].passed=true",
  ],
  verify: [
    "passed 与 mustFix 必须一致：passed=true 时 mustFix 必须为空，passed=false 时 mustFix 必须非空",
    "allPassed 应与 packageResults 一致：allPassed=true 当且仅当所有 packageResults[].passed=true",
    "compilation.success=false 时 errors 必须非空",
  ],
  fix: [
    "fixedPackages 不能为空，fix 必须至少修复一个包",
  ],
}

// ═══════════════════════════════════════════════════════════════
// 2. 非 Zod 校验规则 — validateArtifactOnDisk() 中的额外检查
// ═══════════════════════════════════════════════════════════════

/**
 * 引擎级校验规则（Zod schema 无法表达的文件名一致性、跨文件覆盖等检查）。
 * phases: 该规则适用的阶段列表。
 */
export const NON_ZOD_VALIDATION_RULES: { phases: string[]; message: string }[] = [
  {
    phases: ["inventory"],
    message: "packages/{PKG}.json: packageName 必须与文件名一致（大小写不敏感）",
  },
  {
    phases: ["inventory"],
    message: "inventory.json 的 packageNames 必须覆盖 packages/ 下所有包文件（含 header-only 包：只有 constants/exceptions/variables/types 而没有 procedures/functions 的包，bodyPath 为 null）",
  },
  {
    phases: ["scaffold"],
    message: "scaffold.json 的 projectRoot 必须是 Runtime Context / workOrder 注入的 projectRoot 值（绝对路径 generated/{artifactId}，原样使用，勿自行编造）",
  },
  {
    phases: ["translate", "review", "verify"],
    message: "translations/{pkg}/ 目录名必须与 packageName 一致（大小写不敏感）",
  },
  {
    phases: ["dedup"],
    message: "增量模式下 dedup.json 必须保留非目标包数据（scanStats.totalPackages 须等于 inventory 包数）",
  },
  {
    phases: ["verify"],
    message: "verify-summary.json 的 testFiles[] 中的路径必须实际存在于磁盘",
  },
  {
    phases: ["scaffold"],
    message: "scaffold.json 的 generated.entities / h2SchemaFile 由引擎确定性生成并 patch（DO + schema-h2.sql 落盘 projectRoot）——LLM 不填这两个字段",
  },
]

// ═══════════════════════════════════════════════════════════════
// 3. L3 质量门控 — 确定性数值门控阈值
// ═══════════════════════════════════════════════════════════════

/**
 * L3 质量门控提示（仅出现在有门控的阶段）。
 * 阈值从 engine-core.ts 的 QUALITY_GATE_THRESHOLDS 引用，避免硬编码漂移。
 */
export const QUALITY_GATE_HINTS: Record<string, string[]> = {
  translate: [
    `G1: 翻译完成率 (completedSubprograms/totalSubprograms) ≥ ${Math.round(QUALITY_GATE_THRESHOLDS.COMPLETION_RATIO * 100)}% [blocking]`,
    "G2: subprogramMethods 数量应 ≥ completedSubprograms [warning]",
  ],
  review: [
    `G3: passed=true 但 overallScore < ${QUALITY_GATE_THRESHOLDS.REVIEW_PASS_SCORE} → blocking`,
    "G4: allPassed=true 但 totalMustFix > 0 → blocking（逻辑不一致）",
  ],
  verify: [
    "G5: compilation.success=false 但 allPassed=true → blocking",
    `G6: 测试通过率 (passedTests/totalTests) ≥ ${Math.round(QUALITY_GATE_THRESHOLDS.TEST_PASS_RATIO * 100)}% [warning]`,
  ],
}

// ═══════════════════════════════════════════════════════════════
// 4. 跨 Schema 校验规则 — 仅 needsCrossSchemaValidation=true 的阶段
// ═══════════════════════════════════════════════════════════════

/**
 * 跨 Schema 校验提示（仅出现在 needsCrossSchemaValidation=true 的阶段）。
 * key 应与 workflow-definitions.ts 中 needsCrossSchemaValidation=true 的 phase 名一致。
 */
export const CROSS_SCHEMA_HINTS: Record<string, string[]> = {
  inventory: [
    "依赖图（callGraph 等）由 dependency-graph.ts 从 subprograms/*.json 的 directCalls 按需推导（不落盘）：packageNames 必须与 inventory 包名一致（大小写不敏感）",
    "callGraph 的 key/value 必须为 PKG.refName 格式；refName 须落在该包 subprograms 推导的合法集合内（非重载=裸名，重载={name}__序号，大小写不敏感计数重载）",
    "translationOrder 必须覆盖所有包",
  ],
  scaffold: [
    "scaffold.packageMappings 必须覆盖所有 inventory 包的 plsqlPackage（scope 模式下覆盖 scopePackages）",
  ],
  translate: [
    "subprogramMethods.plsqlName 必须唯一且符合 refName 规范（重载用 {name}__序号）",
  ],
  dedup: [
    "extractedModules.affectedPackages 和 packageChanges.packageName 必须引用 inventory 中存在的包",
  ],
}

// ═══════════════════════════════════════════════════════════════
// 5. 常见被拒原因 — 枚举大小写、跨字段约束、格式陷阱等高频 advance 拒绝原因
// ═══════════════════════════════════════════════════════════════

/**
 * 每个 phase 的常见被拒原因。
 * key = phase 名（与 REFINE_CONSTRAINTS 等同）。
 *
 * 与 artifact-schemas.ts 中的 Zod enum 定义保持一致，
 * 测试会校验枚举值匹配。
 */
export const COMMON_PITFALLS: Record<string, string[]> = {
  inventory: [
    'optional 字段（defaultValue/bodyPath/returnType/headerPath/ddlFile 等）可省略或写 null，均可通过校验',
    'parameters[].mode 自动 normalize 为大写："in"/"In"/"IN" 均等价于 "IN"，"in out"/"IN OUT" 均等价于 "IN OUT"',
    'subprograms[].type 严格大写枚举："PROCEDURE" / "FUNCTION"（不 normalize，必须全大写）；directCalls[].kind 严格小写："function" / "procedure"',
    'triggers.timing 自动 normalize 为小写：任意大小写均可通过',
    'triggers.level 自动 normalize 为小写：任意大小写均可通过',
    'triggers.events 每个元素自动 normalize 为小写：任意大小写均可通过',
    'packages/{PKG}.json 的 procedures/functions 仅为名字数组；子程序详情（parameters/bodyLocation/directCalls）在 subprograms/{PKG.METHOD}.json',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
  scaffold: [
    'commonModules.classes.category 推荐全小写，如 "type-mapper" / "mybatis-fragment" / "mapper-interface" / "test-base"（不限死）',
    'projectRoot 为绝对路径（generated/{artifactId}），必须原样使用 Runtime Context / workOrder 注入的 projectRoot 值，勿自行编造路径',
    'constants 为 per-package {Pkg}Constant 常量类清单、stateDtos 为 per-package {Pkg}StateDTO 变量 DTO 清单（{file, plsqlSchema, plsqlPackage}），scaffold 从 inventory constants / variables 分别生成',
    'procClassNames 为 per-proc 去重类名映射（{plsqlSchema, plsqlPackage, refName, className}），跨包同名碰撞加数字后缀；translate 据此 + 角色后缀派生类名，跨包调用按 service.{className}Service 派生',
    'packageMappings.components 为 per-proc 角色集模板（{role}，无 className），类名由 procClassNames 去重基名 + {RoleSuffix} 派生',
    'DO 实体（generated.entities）+ schema-h2.sql（generated.h2SchemaFile）由引擎在 scaffold 完成后确定性生成并 patch——LLM 不生成 DO/schema-h2、不填这两个字段、不读 tables 数据',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
  translate: [
    'status 推荐值："completed" / "partial"（不限死，允许其他状态值）',
    'files.role 推荐值："mapper-interface" / "mapper-xml" / "service" / "service-impl" / "dto" / "exception" / "test" / "mapper-integration-test"（不限死）',
    'confidence 推荐小写："high" / "medium" / "low"',
    'subprogramMethods.plsqlName：重载子程序必须用 {name}__序号，禁止裸名重复',
    'totalSubprograms 等数字字段支持字符串自动转换（写 "5" 等同 5）',
    'files.role 使用 "mapper-integration-test" 标识 Mapper 集成测试文件',
    '生产 Mapper XML 保持 PL/SQL 原生语法不变',
    'H2 确实不兼容的 SQL 标 @Disabled（不修改 Mapper XML）',
    '测试数据 INSERT 使用硬编码 ID 值（不使用 SEQ.NEXTVAL）',
    'JdbcTemplate INSERT 测试数据的列必须与 schema-h2.sql 一致',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
  review: [
    'severity 推荐小写："critical" / "major" / "minor" / "info"（不限死）',
    'checks.category 推荐全小写，如 "logic-equivalence" / "null-handling" / "exception-mapping" 等（不限死）',
    'passed=true 时 mustFix 必须为 []，passed=false 时 mustFix 必须非空——这是最常见的被拒原因',
    'overallScore 范围 0-100，passed=true 时必须 ≥ 70',
    'suggestions 可写字符串数组或对象数组',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
  verify: [
    'compilation.success=false 时 compilation.errors 必须存在（空数组 [] 也可通过）',
    'passed=true 时 mustFix 必须为 []，passed=false 时 mustFix 必须非空',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
  dedup: [
    'extractedModules.category 推荐全小写，如 "type-mapper" / "mybatis-fragment" / "mapper-interface" / "test-base"（不限死）',
    'affectedPackages 和 packageChanges.packageName 必须引用 inventory 中实际存在的包名',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
  fix: [
    'fixedPackages 不能为空数组，至少包含一个被修复的包名',
    'Schema 允许额外字段（.passthrough()）——可添加不在 schema 中的 optional 字段帮助下游阶段，额外字段会透传不被剥离',
  ],
}
