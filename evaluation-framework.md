# 存储过程 SQL 转 Java 测评体系——设计方案

## 一、项目现状与测评盲区

### 1.1 已有的质量保障机制

| 层次 | 机制 | 覆盖范围 | 成熟度 |
|------|------|---------|--------|
| **review 阶段** | 18 类审查清单（logic-equivalence → test-correctness） | 语义等价、代码规约、测试质量 | ★★★★ |
| **verify 阶段** | mvn compile + MyBatis XML 校验 + mvn test | 编译正确性、框架集成 | ★★★★ |
| **fix 循环** | review/verify 失败 → fix → review 回环（最多 5 轮） | 自动修复闭环 | ★★★☆ |
| **metrics 采集** | PhaseMetricsCollector（token/cost/工具调用/业务数据） | 运行效率指标 | ★★★★ |
| **Schema 校验** | Zod schema + validateCrossSchema (D9) | 结构一致性 | ★★★★ |

### 1.2 五个测评盲区

1. **没有基准真值**——review 是 LLM 审 LLM，存在"自说自话"风险
2. **评分不可复现**——review 的 0-100 分由 LLM 自由裁量，不同运行之间不可比
3. **没有行为等价验证**——mvn test 只验证单元测试通过，不验证 PL/SQL 与 Java 的行为一致性
4. **缺少回归对比**——每次 prompt 改动或模型切换后，无法自动评估变好还是变差
5. **效率与质量脱节**——知道花了多少钱，不知道每块钱换来了多少质量

---

## 二、测评体系总架构

### 2.1 四层测评模型

```
┌─────────────────────────────────────────────────────────────────────┐
│              L4: 行为等价度量（难度最高，价值最大）              │
│  给 PL/SQL 和 Java 相同的输入，对比输出是否一致                       │
│  工具：PostgreSQL 实例 + YAML 测试用例 + 宽容比对器                    │
├─────────────────────────────────────────────────────────────────────┤
│              L3: 语义分析度量（填补最大盲区）                    │
│  SQL 覆盖率（每条 SQL 有对应 MyBatis 映射吗？）                       │
│  控制流匹配（if/loop/exception 结构一致吗？）                         │
│  类型映射合规（参数类型按映射表翻译了吗？）                            │
├─────────────────────────────────────────────────────────────────────┤
│              L2: 代码质量度量（确定性最高，立即可做）                  │
│  编译、测试通过、规约合规、TODO 残留、代码覆盖率                       │
│  工具：mvn compile/test + Checkstyle + JaCoCo + Animal Sniffer       │
├─────────────────────────────────────────────────────────────────────┤
│              L1: 转译效率度量（数据已有，只需计算）                    │
│  单子程序成本、首次通过率、fix 循环次数、吞吐量                        │
│  工具：直接复用 PhaseMetricsCollector 已有数据                        │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 使用方式：OpenCode 斜杠命令

评估通过 `/sql2java_evaluation` 斜杠命令在 OpenCode 中直接执行，与 `/sql2java` 转译命令同级：

```bash
# 先转译
/sql2java resources/mfg_erp_sql_tiny

# 再评估（无需传参，自动从 artifacts 推导 source 和 output）
/sql2java_evaluation
```

命令定义文件：`.opencode/command/sql2java_evaluation.md`

Agent 通过 bash 工具执行 `mvn`、`grep`、`find` 等跨平台命令，不依赖特定 OS 环境。

### 2.3 测评数据集（三级，全部已有）

| 数据集 | 路径 | 文件数 | SQL 行数 | 用途 | 跑一次耗时 |
|--------|------|--------|---------|------|-----------|
| **tiny** | `resources/mfg_erp_sql_tiny/`（已有） | 11 文件 | ~412 行 | 快速回归（每次 prompt 改动后跑） | ~10 分钟 |
| **mini** | `resources/mfg_erp_sql_mini/`（已有） | 30 文件 | ~1500 行 | 中等规模集成测试 | ~40 分钟 |
| **full** | `resources/mfg_erp_sql/`（已有） | 56 文件 | ~6126 行 | 完整评估（模型切换/大版本更新） | ~2-3 小时 |

**`mfg_erp_sql_tiny` 覆盖的 PL/SQL 构造**（作为快速回归测试集的天然优势）：

| 文件 | 子程序/构造 | 翻译难点覆盖 |
|------|-----------|-------------|
| `pkg/base_pkg_spec.sql` | 常量 + 异常 + PRAGMA EXCEPTION_INIT | spec-only 包 → 常量类 + 异常枚举 |
| `pkg/core_pkg_spec.sql` | 包变量、RECORD、关联数组、%ROWTYPE | 包级全局 → 实例字段、RECORD → DTO |
| `pkg/core_pkg_body.sql` (175 行) | log_error（PRAGMA AUTONOMOUS） | 自治事务 → `@Transactional(REQUIRES_NEW)` |
| | get_item（%ROWTYPE + NO_DATA_FOUND） | SELECT INTO → Mapper + 异常映射 |
| | get_item_obj（多态 CASE 分派） | 对象类型继承 → 工厂方法 |
| | create_item × 2（重载） | 参数个数/类型重载 → Java 方法重载 |
| | get_bom_components（BULK COLLECT） | BULK COLLECT INTO → List |
| | explode_bom（PIPELINED + PIPE ROW） | 管道函数 → Stream/List 返回 |
| | list_bom（CONNECT BY + SYS_REFCURSOR） | 层次查询 + REF CURSOR → Mapper + List |
| | bom_cost（递归 PL/SQL） | 递归函数 → 递归 Java 方法 |
| | bulk_receive（FORALL SAVE EXCEPTIONS） | 批量操作 → MyBatis batch executor |
| | issue_fifo（窗口函数 + WHERE CURRENT OF） | FIFO 发料 → 查+批量更新 |
| | archive_before（EXECUTE IMMEDIATE） | 动态 SQL → `// TODO` 或 JdbcTemplate |
| `func/fn_abc_class.sql` | DETERMINISTIC 独立函数 | 纯函数 → 静态方法 |
| `type/types.sql` | t_dimension（值对象 + MEMBER FUNCTION） | 对象类型 → Java 值对象类 |
| | t_item_obj（抽象基类 + NOT INSTANTIABLE） | 抽象类 → abstract class |
| | t_raw_material_obj（UNDER + OVERRIDING） | 继承 → extends + @Override |
| | t_bom_comp_tab（嵌套表） | TABLE OF → List\<T\> |
| `trigger/trg_item_audit.sql` | 行级触发器 + WHEN | 触发器 → AOP/MyBatis Interceptor |

---

## 三、目录结构

```
.opencode/
├── command/
│   ├── sql2java.md                     # 转译命令（已有）
│   └── sql2java_evaluation.md          # 评估命令（新建）
│
└── evaluation/
    └── sql2java/                       # 评估体系二级目录
        ├── quality-rules/
        │   └── checkstyle.xml          # Checkstyle 规则（映射 java-code-spec.md 强制条款）
        │
        ├── equivalence-cases/                 # L4 行为等价度量用例（含 db_level 标注）
        │   ├── fn_abc_class.yaml       # 独立函数: ABC 分类（DETERMINISTIC 纯计算）
        │   ├── core_pkg_log_error.yaml # PRAGMA AUTONOMOUS_TRANSACTION + INSERT + COMMIT
        │   ├── core_pkg_get_item.yaml  # %ROWTYPE 返回 + NO_DATA_FOUND 异常
        │   ├── core_pkg_get_item_obj.yaml  # 多态对象构造（CASE 分派子型）
        │   ├── core_pkg_create_item.yaml   # 重载过程 + RETURNING INTO + NVL
        │   ├── core_pkg_get_bom_components.yaml  # BULK COLLECT INTO 对象集合
        │   ├── core_pkg_explode_bom.yaml   # PIPELINED 函数 + PIPE ROW
        │   ├── core_pkg_list_bom.yaml      # CONNECT BY + SYS_REFCURSOR + SYS_CONNECT_BY_PATH
        │   ├── core_pkg_bom_cost.yaml      # 递归 PL/SQL 函数（BOM 成本卷算）
        │   ├── core_pkg_bulk_receive.yaml  # FORALL SAVE EXCEPTIONS + MERGE INTO
        │   ├── core_pkg_issue_fifo.yaml    # 窗口函数 + FOR UPDATE + WHERE CURRENT OF
        │   ├── core_pkg_archive_before.yaml # EXECUTE IMMEDIATE + USING 动态 SQL
        │   └── trg_item_audit.yaml         # 行级触发器 + WHEN 条件 + :old/:new
        │
        ├── measurement-cases/          # L3 语义分析度量用例
        │   ├── fn_abc_class.yaml       # 预期: 无 SQL、if:3、return:4
        │   ├── core_pkg_log_error.yaml # 预期: INSERT:1、表 t_error_log、catch:1
        │   ├── core_pkg_get_item.yaml  # 预期: SELECT:1、NO_DATA_FOUND→异常映射
        │   ├── core_pkg_get_item_obj.yaml
        │   ├── core_pkg_create_item.yaml
        │   ├── core_pkg_get_bom_components.yaml
        │   ├── core_pkg_explode_bom.yaml
        │   ├── core_pkg_list_bom.yaml
        │   ├── core_pkg_bom_cost.yaml
        │   ├── core_pkg_bulk_receive.yaml  # 预期: FORALL→batch、MERGE→insertOrUpdate
        │   ├── core_pkg_issue_fifo.yaml
        │   ├── core_pkg_archive_before.yaml
        │   └── trg_item_audit.yaml
        │
        └── baselines/                  # 历史基线存储（以 runId 命名，与 artifacts 对应）
            └── run-20260612-143022/
                ├── eval-report.json    # 机器可读综合报告
                ├── eval-report.md      # 人类可读综合报告
                ├── l1-metrics.json     # L1 转译效率度量
                ├── l2-summary.json     # L2 代码质量度量
                ├── l2-checkstyle.log   # Checkstyle 原始输出
                ├── l2-compile-errors.log  # 编译错误（仅失败时）
                ├── l2-jacoco.csv       # JaCoCo 覆盖率原始数据
                ├── l3-summary.json     # L3 语义分析度量
                └── l4-summary.json     # L4 行为等价度量
```

### test-cases 各文件说明

每个 YAML 文件对应 `mfg_erp_sql_tiny` 中一个子程序，测试该子程序的 PL/SQL → Java 行为等价性。
按翻译难度分为三级：**P0 基础**（纯计算/简单 CRUD）、**P1 中等**（异常/集合/重载）、**P2 高难**（递归/动态 SQL/游标）。

| 文件 | 子程序 | 难度 | 测试的 PL/SQL 构造 | 期望 Java 映射 | 验证要点 |
|------|--------|------|-------------------|---------------|---------|
| **`fn_abc_class.yaml`** | `fn_abc_class` | P0 | DETERMINISTIC 独立函数、IF/ELSIF/ELSE、NULL 处理 | 静态工具方法 `AbcClassUtil.classify()` | 返回值正确、NULL→null、边界值 80%/95%、自定义阈值参数 |
| **`core_pkg_log_error.yaml`** | `log_error` | P1 | PRAGMA AUTONOMOUS_TRANSACTION、INSERT、COMMIT、序列 NEXTVAL | `@Transactional(propagation=REQUIRES_NEW)` + Mapper.insert | 日志行写入成功、独立事务提交（外层回滚时日志仍在）、序列值递增 |
| **`core_pkg_get_item.yaml`** | `get_item` | P1 | SELECT INTO、%ROWTYPE 返回、NO_DATA_FOUND → RAISE_APPLICATION_ERROR | Mapper.selectById → 返回 `ItemDO`、找不到时抛 `BizException` | 正常返回全部字段、不存在时抛异常（错误码 -20101）、返回类型完整 |
| **`core_pkg_get_item_obj.yaml`** | `get_item_obj` | P2 | 多态构造、CASE WHEN 分派、对象类型实例化（构造器调用） | 工厂方法 `getItemObj()`，按 item_type 返回不同子类 | RAW 类型返回 `RawMaterialObj`、其他返回 null、字段值正确传递 |
| **`core_pkg_create_item.yaml`** | `create_item` ×2 | P1 | 过程重载（参数个数不同）、INSERT + RETURNING INTO、NVL、OUT 参数、序列 | 两个重载方法、Mapper.insert + useGeneratedKeys、OUT→返回值或 DTO | 重载版1 无 cost 字段、重载版2 有 cost+NVL(0)、OUT 参数值正确、唯一约束冲突时异常 |
| **`core_pkg_get_bom_components.yaml`** | `get_bom_components` | P1 | BULK COLLECT INTO、对象构造器 `t_bom_comp_obj(...)` 调用、JOIN 查询、返回嵌套表 | Mapper.selectList → `List<BomCompObj>` | 返回 List 长度正确、每个元素的三个字段值正确、空 BOM 返回空 List |
| **`core_pkg_explode_bom.yaml`** | `explode_bom` | P2 | PIPELINED 函数、PIPE ROW、FOR...IN cursor LOOP、多表 JOIN | 普通方法返回 `List<BomCompObj>`（PIPELINED→直接收集返回） | 返回组件列表正确、仅 ACTIVE 状态 BOM、多层展开结果完整 |
| **`core_pkg_list_bom.yaml`** | `list_bom` | P2 | CONNECT BY + NOCYCLE + PRIOR、SYS_REFCURSOR（OUT 参数）、LEVEL、SYS_CONNECT_BY_PATH、ORDER SIBLINGS BY | Mapper 递归查询或 Java 递归方法、OUT SYS_REFCURSOR → List 返回 | 层级号正确、路径字符串格式正确、叶节点标记正确、环路不报错 |
| **`core_pkg_bom_cost.yaml`** | `bom_cost` | P2 | 递归 PL/SQL 函数（自调用）、ROUND、NVL、嵌套 EXCEPTION WHEN NO_DATA_FOUND | 递归 Java 方法 `bomCost()`，递归遍历 BOM 子节点 | 单层 BOM 返回 std_cost、多层 BOM 返回卷算成本、无 BOM 时返回 std_cost、不存在的 item 返回 0 |
| **`core_pkg_bulk_receive.yaml`** | `bulk_receive` | P2 | FORALL SAVE EXCEPTIONS、SQL%BULK_EXCEPTIONS、INDEX BY 关联数组、MERGE INTO、SQLCODE 判断 | MyBatis batch executor + 单行异常收集、MERGE→insertOrUpdate | 正常批量全部成功、部分失败时 ok 数正确、失败行日志记录、MERGE 回写 std_cost 正确 |
| **`core_pkg_issue_fifo.yaml`** | `issue_fifo` | P2 | 窗口函数 SUM() OVER (ORDER BY...)、FOR UPDATE 游标、WHERE CURRENT OF、EXIT WHEN、LEAST | 查可用批次 List + 逐批更新（无 WHERE CURRENT OF 等价） | FIFO 顺序正确（按 receipt_date）、跨批次扣减正确、数量不足时部分扣减 |
| **`core_pkg_archive_before.yaml`** | `archive_before` | P2 | EXECUTE IMMEDIATE 动态 SQL、USING 绑定变量、SQL%ROWCOUNT | `// TODO: [translate]` 或 JdbcTemplate.execute | 删除行数正确（SQL%ROWCOUNT→返回值）、日期边界精确、绑定变量防注入 |
| **`trg_item_audit.yaml`** | `trg_item_audit` | P1 | AFTER UPDATE OF 指定列、FOR EACH ROW、WHEN 条件（值变化检测）、:old/:new 引用 | AOP 拦截或 MyBatis Interceptor | 仅 std_cost 变化时触发、status 变化也触发、其他列变化不触发、审计日志 JSON 格式正确 |

---

## 四、输入输出规范

### 4.1 全局输入输出

**评估工具入口**（OpenCode 斜杠命令）

```
/sql2java_evaluation [选项]
```

所有参数均可选，默认从最近一次 `/sql2java` 运行的 artifacts 中自动推导。

| 选项 | 必填 | 说明 | 不传时自动推导 |
|------|------|------|---------------|
| `--source <dir>` | 否 | PL/SQL 源码目录 | `inventory-index.json` → `sourcePath` |
| `--output <dir>` | 否 | Java 项目目录 | `scaffold.json` → `projectRoot` |
| `--run-id <id>` | 否 | 工作流 runId | 最新的 `run-*` 目录 |
| `--layers <list>` | 否 | 运行哪些层级（默认 l1,l2,l3,l4） | — |
| `--resume` | 否 | 从上次中断处继续评估 | — |
| `--status` | 否 | 查看当前评估状态 | — |

**总输出**：

```
.opencode/evaluation/sql2java/baselines/{runId}/
├── eval-report.json      # 机器可读综合报告（包含所有层级得分 + 原始数据）
└── eval-report.md        # 人类可读综合报告（表格 + 评级 + 解读建议）
```

### 4.2 各层输入输出

#### L1: 转译效率度量

```
输入                                  输出
───────────────────────               ───────────────────────
.workflow-artifacts/{runId}/          l1-metrics.json
├── metrics/                          ├─ runId, status
│   ├── run-metrics.json ← 读取      ├─ total_cost
│   ├── translate.json                ├─ cost_per_subprogram
│   ├── review.json                   ├─ throughput_per_hour
│   └── fix-*.json                    ├─ fix_cost_ratio
└── review-summary.json               ├─ first_pass_rate
└── verify-summary.json               ├─ compilation_success
                                      ├─ todos_remaining
                                      └─ fix_cycles
```

**数据源**：`PhaseMetricsCollector` 已自动采集到 `.workflow-artifacts/{runId}/metrics/`。

**l1-metrics.json 结构**（分组设计，费用组条件省略）：

```typescript
interface L1Metrics {
  runId: string
  status: string
  datasetLevel: "tiny" | "mini" | "full"

  summary: {
    firstPassRate: number | null         // review 首次通过率 (%)
    fixCycles: number                    // fix 循环次数
    fixCostRatio: number                 // fix 成本占总成本比例
    totalDurationMs: number              // 总耗时（毫秒）
    totalApiCalls: number                // LLM API 调用总数
    totalToolCalls: number               // 工具调用总数
  }

  tokens: {                              // 确定性数据，永不省略
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    reasoning: number
    total: number                        // input+output+cacheRead+cacheWrite+reasoning
  }

  cost?: {                               // 仅 totalCost > 0 时写入，否则整组省略
    totalCost: number                    // 总费用（美元）
    costPerSubprogram: number            // 单子程序费用（oracleProcedures>0 时才写入）
  }

  throughput: {
    oracleProcedures: number
    throughputPerHour: number | null     // 每小时翻译子程序数（条件计算）
    durationPerPhase: Record<string, number>  // { phase名: wallDurationMs }
  }

  output: {
    oraclePackages: number
    oracleProcedures: number
    javaFiles: number
    testFiles: number
    todosRemaining: number
    compilationSuccess: boolean | null
    reviewAverageScore: number | null
  }

  phaseBreakdown: Array<{               // 逐阶段明细，永不省略
    phase: string
    durationMs: number
    apiCalls: number
    tokens: { input: number; output: number }
  }>
}
```

#### L2: 代码质量度量

```
输入                                  输出
───────────────────────               ───────────────────────
--output <java-dir>                  l2-summary.json
├── src/main/java/ ← 扫描 Java 文件   ├─ scores { compile, test, todo,
├── src/main/resources/ ← MyBatis XML │            style, coverage, java8,
├── src/test/java/ ← 测试代码         │            total }
├── target/surefire-reports/ ← 读取   ├─ grade: "A+"|"A"|"B"|"C"|"D"
└── pom.xml ← mvn 命令               └─ details { ... }

--source <sql-dir>                    l2-checkstyle.log   (Checkstyle 原始输出)
└── **/*.sql ← 统计 SQL 行数          l2-jacoco.csv       (覆盖率原始数据)
                                      l2-compile-errors.log (编译错误，仅失败时)

evaluation/quality-rules/checkstyle.xml
└── 规约规则定义
```

**执行的命令**（跨平台，通过 Node.js `child_process.execSync`）：

| 步骤 | 命令 | 产出文件 | 失败行为 |
|------|------|---------|---------|
| 编译 | `mvn compile -q` | l2-compile-errors.log | 记录错误，继续 |
| 测试 | `mvn test -q` | target/surefire-reports/ | 记录失败，继续 |
| Checkstyle | `mvn checkstyle:check -Dcheckstyle.config.location=...` | l2-checkstyle.log | 记录违规，继续 |
| JaCoCo | `mvn test jacoco:report -q` | target/site/jacoco/jacoco.csv | 缺失则标记 N/A |

**l2-summary.json 结构**：

```typescript
interface L2Summary {
  scores: {
    compile: number      // 0 或 100
    test: number         // 0-100（测试通过率）
    todo: number         // 0-100（1 - TODO残留率）
    style: number        // 0-100（1 - 违规数/总行数）
    coverage: number     // 0-100（JaCoCo 指令覆盖率）
    java8: number        // 0-100（1 - Java9+违规数/文件数）
    total: number        // 加权总分
  }
  grade: "A+" | "A" | "B" | "C" | "D"
  details: {
    compileSuccess: boolean
    compileErrors: number
    totalTests: number
    passedTests: number
    failedTests: number
    testPassRate: number
    todoTranslate: number     // [translate] TODO 数量
    todoTest: number          // [test] TODO 数量
    todoOther: number
    checkstyleViolations: number
    checkstyleByName: number  // 命名类违规
    checkstyleByFormat: number
    checkstyleByOop: number
    checkstyleByException: number
    coveragePct: number | null
    java9Violations: number   // Java 9+ API 使用数
    sqlLoc: number            // PL/SQL 总行数
    javaLoc: number           // Java 总行数
    locRatio: number          // Java/PL/SQL 膨胀比
    javaFileCount: number
  }
}
```

#### L3: 语义分析度量

```
输入                                  输出
───────────────────────               ───────────────────────
--output <java-dir>                  l3-summary.json
├── src/main/java/ ← 提取 Java 结构   ├─ scores { sql_coverage,
├── src/main/resources/ ← MyBatis XML │            table_coverage,
│                                      │            subprogram_coverage,
--source <sql-dir>                     │            exception_mapping,
└── **/*.sql ← 提取 SQL 语句          │            control_flow, total }
                                      └─ details { ...
--run-id → .workflow-artifacts/            measurementCases[] }
├── inventory-index.json ← 子程序清单
└── translations/*/translation.json

measurement-cases/*.yaml ← 逐子程序预期结构特征
```

**l3-summary.json 结构**：

```typescript
interface L3Summary {
  scores: {
    sqlCoverage: number        // 0-100（MyBatis 映射数 / PL/SQL SQL 语句数）
    tableCoverage: number      // 0-100（MyBatis 引用的表 / PL/SQL 引用的表）
    subprogramCoverage: number // 0-100（有 Java 方法匹配的子程序 / 总子程序）
    exceptionMapping: number   // 0-100（catch 数 / EXCEPTION WHEN 数的匹配度）
    controlFlow: number        // 0-100（if/loop/return 结构向量余弦相似度）
    total: number
  }
  details: {
    plsqlStatements: {
      select: number
      insert: number
      update: number
      delete: number
      merge: number
      total: number
    }
    mybatisMappings: {
      select: number
      insert: number
      update: number
      delete: number
      total: number
    }
    plsqlTables: string[]         // PL/SQL 中引用的表名列表
    mybatisTables: string[]       // MyBatis XML 中引用的表名列表
    uncoveredTables: string[]     // PL/SQL 有但 MyBatis 未覆盖的表
    totalSubprograms: number
    mappedSubprograms: number
    unmappedSubprograms: string[] // 未找到 Java 方法匹配的子程序名
    plsqlExceptions: number       // EXCEPTION WHEN 块数
    javaCatches: number           // catch 块数
    plsqlRaises: number           // RAISE_APPLICATION_ERROR 数
    javaThrows: number            // throw new 数
    controlFlowVectors: {
      plsql: { if: number; loop: number; return: number }
      java: { if: number; loop: number; return: number }
      cosineSimilarity: number    // 0-1（1=完全匹配）
    }
    measurementCases: Array<{       // 逐子程序测量用例比对结果
      subprogram: string
      status: "passed" | "failed"
      checks: {
        sql_statements?: { expected: Record<string, number>; actual: Record<string, number>; pass: boolean }
        tables?: { expected: string[]; actual: string[]; pass: boolean }
        control_flow?: { expected: Record<string, number>; actual: Record<string, number>; pass: boolean }
        exceptions?: { expected: string; actual: string; pass: boolean }
        type_mappings?: { total: number; violations: number; pass: boolean }
        special_constructs?: Record<string, "pass" | "fail">
      }
    }>
  }
}
```

#### L4: 行为等价度量

```text
输入                                  输出
───────────────────────               ───────────────────────
.opencode/evaluation/sql2java/equivalence-cases/*.yaml  l4-summary.json
├── test_suite (含 db_level)          ├─ scores { equivalence_rate }
├── setup.sql                         ├─ executionMode: "full_pg" | "degraded_h2"
├── cases[].pg_call                    ├─ degradedInfo (降级时)
├── cases[].java_call                 ├─ total_cases, passed, failed, skipped
└── cases[].expected                  ├─ skippedDetail { pg_only: [...] }
                                      └─ details { case_results[] }
--output <java-dir>
└── src/ ← 被测 Java 代码

数据库连接（三级降级）
├── PostgreSQL 实例 → full_pg 全量比对
├── H2 内存库 → h2_compatible 用例
└── 无数据库 → pure_java 用例 + pg_only 跳过
```

**l4-summary.json 结构**：

```typescript
interface L4Summary {
  scores: {
    equivalenceRate: number     // 0-100（通过用例 / 可执行用例，pg_only 不计入分母）
  }
  executionMode: "full_pg" | "degraded_h2"  // 执行模式
  degradedInfo: DegradedInfo | null          // 降级信息（full_pg 时为 null）
  totalCases: number
  passedCases: number
  failedCases: number
  skippedCases: number          // pg_only 跳过数
  skippedDetail: {
    pg_only: string[]           // pg_only 跳过的用例描述列表
  }
  details: {
    caseResults: Array<{
      suite: string             // 测试套件名
      caseName: string          // 用例名
      status: "passed" | "failed" | "skipped_pg_only" | "error"
      mode: "full_pg" | "pure_java" | "h2" | "pg_only"  // 执行模式
      oracleOutput?: unknown    // Oracle 执行结果（仅 full_pg）
      javaOutput?: unknown      // Java 执行结果
      diffs?: Array<{           // 差异详情
        field: string
        expected: unknown
        actual: unknown
      }>
    }>
  }
}

interface DegradedInfo {
  level1_pureJavaCases: number   // 纯 Java 测试用例数
  level2_h2Cases: number         // H2 集成测试用例数
  level3_pgOnlySkipped: number   // PG 专用跳过用例数
  pgAvailable: boolean           // PostgreSQL 是否可用
}
```

### 4.3 综合报告输出

**eval-report.json 结构**：

```typescript
interface EvalReport {
  // 元信息
  date: string
  runId: string
  sourcePath: string
  projectPath: string
  datasetLevel: "tiny" | "mini" | "full"

  // 各层得分
  layers: {
    l1: L1Metrics | null
    l2: L2Summary | null
    l3: L3Summary | null
    l4: L4Summary | null
  }

  // 综合评分
  totalScore: number            // 加权总分
  grade: "A+" | "A" | "B" | "C" | "D"

  // 权重配置
  weights: {
    l1: number                  // 默认 0.10
    l2: number                  // 默认 0.30
    l3: number                  // 默认 0.35
    l4: number                  // 默认 0.25
  }
}
```

**eval-report.md 样例**：

```markdown
# SQL2Java 转译质量评估报告

- **日期**: 2026-06-12
- **Run ID**: run-20260612-143022
- **数据集**: mfg_erp_sql_tiny (11 文件 / 412 行)
- **模型**: zai-coding-plan/glm-5.1

## 综合评分: 88.5/100 (A)

| 层级 | 得分 | 权重 | 加权分 |
|------|------|------|--------|
| L1 转译效率度量 | 85/100 | 10% | 8.5 |
| L2 代码质量度量 | 93/100 | 30% | 27.9 |
| L3 语义分析度量 | 86/100 | 35% | 30.1 |
| L4 行为等价度量 | 88/100 | 25% | 22.0 |

## L1 转译效率
...（表格）

## L2 代码质量
...（表格 + 违规详情）

## L3 语义分析
...（覆盖率 + 未映射清单）

## L4 行为等价度量
...（用例通过/失败明细）

## 改进建议
1. core_pkg.issue_fifo 的 WHERE CURRENT OF 翻译缺失，建议标记为 TODO
2. 3 处 Checkstyle 命名违规需要修复
```

---

## 五、各层实施细节

> **以下各层的详细执行步骤和 bash 命令，见 `.opencode/command/sql2java_evaluation.md`。**
> 本节侧重数据结构定义和评分算法的规格说明，TypeScript 代码仅作逻辑参考。

### 5.1 L1: 转译效率基准

> **实现详见** `.opencode/command/sql2java_evaluation.md` → L1 段落

**数据获取流程**：

L1 数据由 `/sql2java` 工作流在运行过程中通过 `PhaseMetricsCollector` **自动采集**，不需要用户手动传入。
评估命令通过 `runId` 定位数据文件：

```text
用户执行:  /sql2java resources/mfg_erp_sql_tiny
           ↓ 工作流引擎自动采集
产出文件:  .workflow-artifacts/run-20260612-143022/metrics/run-metrics.json
           ↓
用户执行:  /sql2java_evaluation --source resources/mfg_erp_sql_tiny --output generated-project/
           ↓ 自动推导 runId
读取文件:  ls -td .workflow-artifacts/run-* | head -1
           → .workflow-artifacts/run-20260612-143022/metrics/run-metrics.json
```

- **有 `--run-id`**：直接定位 `.workflow-artifacts/{runId}/metrics/run-metrics.json`
- **无 `--run-id`**：自动取 `.workflow-artifacts/` 下最新的 `run-*` 目录
- **找不到**：报错 "未找到工作流 artifacts，请先运行 /sql2java"

**核心逻辑**：从 `run-metrics.json` 提取效率指标并计算派生值。

```typescript
// L1 转译效率指标提取逻辑（伪代码参考，实际由 agent 通过 bash+jq 执行）
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import type { L1Metrics } from "./types"

/**
 * 从 .workflow-artifacts/{runId}/metrics/run-metrics.json 提取 L1 转译效率指标
 *
 * 分组结构：summary/tokens/cost(条件)/throughput/output/phaseBreakdown
 * cost 组仅在 totalCost > 0 时写入，否则整组省略。
 */
export function evaluateL1(artifactsDir: string): L1Metrics {
  const metricsFile = join(artifactsDir, "metrics", "run-metrics.json")
  if (!existsSync(metricsFile)) {
    throw new Error(`未找到 ${metricsFile}，工作流可能未正常完成`)
  }

  const rm = JSON.parse(readFileSync(metricsFile, "utf-8"))
  const oracleProcedures = rm.business?.oracleProcedureCount ?? 0
  const totalDurationMs = rm.totalWallDurationMs ?? 0
  const totalCost = rm.totalCost ?? 0

  // ── fix 成本比 ──
  const fixPhases = (rm.phases ?? []).filter((p: any) => p.phase === "fix")
  const fixCost = fixPhases.reduce((s: number, p: any) => s + (p.totalCost ?? 0), 0)
  const fixCostRatio = totalCost > 0
    ? Math.round((fixCost / totalCost) * 1000) / 1000
    : 0

  // ── summary ──
  const summary = {
    firstPassRate: rm.business?.reviewPassedRate ?? null,
    fixCycles: rm.business?.fixCyclesCount ?? 0,
    fixCostRatio,
    totalDurationMs,
    totalApiCalls: rm.totalApiCallCount ?? 0,
    totalToolCalls: rm.totalToolCallCount ?? 0,
  }

  // ── tokens（确定性，永不省略） ──
  const t = rm.totalTokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  const tokens = {
    input: t.input ?? 0,
    output: t.output ?? 0,
    cacheRead: t.cacheRead ?? 0,
    cacheWrite: t.cacheWrite ?? 0,
    reasoning: t.reasoning ?? 0,
    total: (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0) + (t.reasoning ?? 0),
  }

  // ── cost（条件：仅 totalCost > 0 时写入） ──
  const cost = totalCost > 0
    ? {
        totalCost,
        ...(oracleProcedures > 0 ? { costPerSubprogram: Math.round((totalCost / oracleProcedures) * 10000) / 10000 } : {}),
      }
    : undefined

  // ── throughput ──
  const throughputPerHour = totalDurationMs > 0 && oracleProcedures > 0
    ? Math.round((oracleProcedures / totalDurationMs * 3600000) * 10) / 10
    : null
  const durationPerPhase: Record<string, number> = {}
  for (const p of (rm.phases ?? [])) {
    if (p.wallDurationMs) durationPerPhase[p.phase] = p.wallDurationMs
  }
  const throughput = {
    oracleProcedures,
    throughputPerHour,
    durationPerPhase,
  }

  // ── output ──
  const output = {
    oraclePackages: rm.business?.oraclePackageCount ?? 0,
    oracleProcedures,
    javaFiles: rm.business?.javaFileCount ?? 0,
    testFiles: rm.business?.testFileCount ?? 0,
    todosRemaining: rm.business?.totalTodosRemaining ?? 0,
    compilationSuccess: rm.business?.compilationSuccess ?? null,
    reviewAverageScore: rm.business?.reviewAverageScore ?? null,
  }

  // ── phaseBreakdown ──
  const phaseBreakdown = (rm.phases ?? []).map((p: any) => ({
    phase: p.phase,
    durationMs: p.wallDurationMs ?? 0,
    apiCalls: p.apiCallCount ?? 0,
    tokens: { input: p.totalTokens?.input ?? 0, output: p.totalTokens?.output ?? 0 },
  }))

  return {
    runId: rm.runId,
    status: rm.status,
    datasetLevel: rm.business?.datasetLevel ?? "tiny",
    summary,
    tokens,
    cost,
    throughput,
    output,
    phaseBreakdown,
  }
}
```

**预期运行效果**（mfg_erp_sql_tiny，费用可用）：

```
l1-metrics.json 示例:
{
  "runId": "run-20260612-143022",
  "status": "completed",
  "datasetLevel": "tiny",
  "summary": {
    "firstPassRate": 100,
    "fixCycles": 0,
    "fixCostRatio": 0.082,
    "totalDurationMs": 480000,
    "totalApiCalls": 42,
    "totalToolCalls": 68
  },
  "tokens": {
    "input": 185000,
    "output": 28000,
    "cacheRead": 95000,
    "cacheWrite": 0,
    "reasoning": 12000,
    "total": 308000
  },
  "cost": {
    "totalCost": 0.85,
    "costPerSubprogram": 0.0567
  },
  "throughput": {
    "oracleProcedures": 15,
    "throughputPerHour": 56.3,
    "durationPerPhase": {
      "inventory": 12000, "analyze": 45000, "plan": 35000,
      "scaffold": 28000, "translate": 180000, "dedup": 60000,
      "review": 75000, "verify": 40000
    }
  },
  "output": {
    "oraclePackages": 2, "oracleProcedures": 15,
    "javaFiles": 18, "testFiles": 4,
    "todosRemaining": 1, "compilationSuccess": true,
    "reviewAverageScore": 88
  },
  "phaseBreakdown": [
    { "phase": "inventory", "durationMs": 12000, "apiCalls": 5, "tokens": { "input": 12000, "output": 3000 } },
    { "phase": "analyze", "durationMs": 45000, "apiCalls": 8, "tokens": { "input": 35000, "output": 8000 } },
    ...
  ]
}
```

**费用不可用时**：`cost` 组整组省略（不写入 JSON），其余组正常输出。

**指标解读基准**：

| 指标 | 健康范围 | 告警阈值 | 含义 |
|------|---------|---------|------|
| firstPassRate | > 80% | < 50% | review 首轮通过率，低于说明 translator prompt 需优化 |
| throughputPerHour | > 40 | < 20 | 每小时翻译子程序数，低于说明响应慢或工具调用过多 |
| fixCycles | 0~1 | > 3 | fix 循环次数，过多说明翻译质量差 |
| fixCostRatio | < 15% | > 30% | fix 成本占比（仅费用可用时评估） |
| costPerSubprogram | $0.03 ~ $0.10 | > $0.20 | 单子程序费用（仅费用可用时评估） |

### 5.2 L2: 代码质量度量

> **实现详见** `.opencode/command/sql2java_evaluation.md` → L2 段落

**核心逻辑**：按顺序执行 7 项确定性检查（编译、测试、LOC、TODO、Checkstyle、JaCoCo、Java 8 合规），每项失败不阻断后续。

```typescript
// L2 代码质量检查逻辑（伪代码参考，实际由 agent 通过 bash 执行 mvn/grep）
import { execSync } from "node:child_process"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { L2Summary } from "./types"

/**
 * 执行 L2 代码质量检查
 *
 * @param projectDir - Java 项目目录（含 pom.xml）
 * @param sourceDir  - PL/SQL 源码目录
 * @param outputDir  - 评估结果输出目录
 * @returns L2Summary
 *
 * 输入:
 *   - projectDir/src/main/java/   Java 源文件
 *   - projectDir/src/test/java/   测试文件
 *   - projectDir/pom.xml          Maven 配置
 *   - sourceDir/**/*.sql          PL/SQL 源文件
 *   - quality-rules/checkstyle.xml       Checkstyle 规则
 *
 * 输出:
 *   - {outputDir}/l2-summary.json
 *   - {outputDir}/l2-checkstyle.log
 *   - {outputDir}/l2-jacoco.csv
 *   - {outputDir}/l2-compile-errors.log (仅编译失败时)
 */
export function evaluateL2(
  projectDir: string,
  sourceDir: string,
  outputDir: string,
): L2Summary {
  const scores: Record<string, number> = {}
  const details: Record<string, unknown> = {}

  // ── Step 1: 编译 ──
  const compileResult = runCommand("mvn compile -q", projectDir)
  scores.compile = compileResult.success ? 100 : 0
  details.compileSuccess = compileResult.success
  details.compileErrors = countLines(compileResult.stderr, "[ERROR]")
  if (!compileResult.success) {
    writeFileSync(join(outputDir, "l2-compile-errors.log"), compileResult.stderr)
  }

  // ── Step 2: 测试 ──
  runCommand("mvn test -q", projectDir)
  const surefireDir = join(projectDir, "target", "surefire-reports")
  const testStats = parseSurefireReports(surefireDir)
  scores.test = testStats.total > 0
    ? Math.round(testStats.passed / testStats.total * 100)
    : 0
  details.totalTests = testStats.total
  details.passedTests = testStats.passed
  details.failedTests = testStats.failed
  details.testPassRate = scores.test

  // ── Step 3: 代码行数 ──
  const sqlLoc = countFileLines(sourceDir, /\.(sql|pks|pkb)$/)
  const javaLoc = countFileLines(join(projectDir, "src"), /\.java$/)
  const javaFileCount = countFiles(join(projectDir, "src"), /\.java$/)
  details.sqlLoc = sqlLoc
  details.javaLoc = javaLoc
  details.locRatio = sqlLoc > 0 ? Math.round(javaLoc / sqlLoc * 100) / 100 : 0
  details.javaFileCount = javaFileCount

  // ── Step 4: TODO 扫描 ──
  const todoTranslate = grepCount(join(projectDir, "src"), "TODO: \\[translate\\]")
  const todoTest = grepCount(join(projectDir, "src"), "TODO: \\[test\\]")
  const todoOther = grepCount(join(projectDir, "src"), "// TODO") - todoTranslate - todoTest
  details.todoTranslate = todoTranslate
  details.todoTest = todoTest
  details.todoOther = todoOther
  const todoRate = javaFileCount > 0 ? todoTranslate / javaFileCount : 0
  scores.todo = Math.max(0, Math.round((1 - todoRate) * 100))

  // ── Step 5: Checkstyle ──
  const checkstyleConfig = join(__dirname, "..", "config", "checkstyle.xml")
  if (existsSync(checkstyleConfig)) {
    const csResult = runCommand(
      `mvn checkstyle:check -Dcheckstyle.config.location=${checkstyleConfig} -q`,
      projectDir,
    )
    const violations = countLines(csResult.stdout + csResult.stderr, "\\[WARN\\]|\\[ERROR\\]")
    writeFileSync(join(outputDir, "l2-checkstyle.log"), csResult.stdout + csResult.stderr)
    details.checkstyleViolations = violations
    scores.style = javaLoc > 0
      ? Math.max(0, Math.round((1 - violations / javaLoc) * 100))
      : 100
  } else {
    scores.style = 100
    details.checkstyleViolations = 0
  }

  // ── Step 6: JaCoCo 覆盖率 ──
  runCommand("mvn test jacoco:report -q", projectDir)
  const jacocoCsv = join(projectDir, "target", "site", "jacoco", "jacoco.csv")
  if (existsSync(jacocoCsv)) {
    const coverage = parseJacocoCsv(jacocoCsv)
    scores.coverage = Math.round(coverage * 100)
    details.coveragePct = Math.round(coverage * 1000) / 10
    copyFileSync(jacocoCsv, join(outputDir, "l2-jacoco.csv"))
  } else {
    scores.coverage = 0
    details.coveragePct = null
  }

  // ── Step 7: Java 8 兼容性 ──
  const java9Violations =
    grepCount(join(projectDir, "src"), "\\bvar\\s+\\w+\\s*=") +      // var 关键字
    grepCount(join(projectDir, "src"), "List\\.of|Map\\.of|Set\\.of") + // Java 9+ 集合
    grepCount(join(projectDir, "src"), "\\.isBlank\\(\\)|\\.strip\\(\\)") // Java 11+ String
  details.java9Violations = java9Violations
  scores.java8 = javaFileCount > 0
    ? Math.max(0, Math.round((1 - java9Violations / javaFileCount) * 100))
    : 100

  // ── 加权总分 ──
  const total = Math.round(
    scores.compile * 0.25 +
    scores.test    * 0.20 +
    scores.todo    * 0.10 +
    scores.style   * 0.15 +
    scores.coverage * 0.15 +
    scores.java8   * 0.15
  ) / 100 * 100  // 归整

  const grade = total >= 95 ? "A+" : total >= 85 ? "A" : total >= 70 ? "B" : total >= 50 ? "C" : "D"

  return { scores: scores as L2Summary["scores"], grade, details: details as L2Summary["details"] }
}

/** 跨平台命令执行（Node.js child_process，Windows/Linux/macOS 通用） */
function runCommand(cmd: string, cwd: string): { success: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, { cwd, encoding: "utf-8", timeout: 300000 })
    return { success: true, stdout, stderr: "" }
  } catch (e: any) {
    return { success: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }
  }
}
```

**预期运行效果**（mfg_erp_sql_tiny）：

```
l2-summary.json 示例:
{
  "scores": {
    "compile": 100,
    "test": 95,
    "todo": 93,
    "style": 97,
    "coverage": 72,
    "java8": 100,
    "total": 92.3
  },
  "grade": "A",
  "details": {
    "compileSuccess": true,
    "compileErrors": 0,
    "totalTests": 42,
    "passedTests": 40,
    "failedTests": 2,
    "testPassRate": 95,
    "todoTranslate": 1,
    "todoTest": 0,
    "todoOther": 2,
    "checkstyleViolations": 4,
    "coveragePct": 72.3,
    "java9Violations": 0,
    "sqlLoc": 412,
    "javaLoc": 1280,
    "locRatio": 3.11,
    "javaFileCount": 18
  }
}
```

### 5.3 L3: 语义分析

> **实现详见** `.opencode/command/sql2java_evaluation.md` → L3 段落
>
> **测量用例**：`.opencode/evaluation/sql2java/measurement-cases/*.yaml`
> 每个用例定义一个子程序的预期结构特征（SQL 数量、表引用、控制流、异常映射、类型映射），
> 评估时逐用例比对实际翻译产出与预期值。详见命令文件中 "L3 测量用例" 段落。

**核心逻辑**：通过 grep/正则对比 PL/SQL 源码与 Java 产出的结构特征。

```typescript
// L3 语义分析逻辑（伪代码参考，实际由 agent 通过 bash grep/find 执行）
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { L3Summary } from "./types"

/**
 * 执行 L3 语义分析
 *
 * @param projectDir   - Java 项目目录
 * @param sourceDir    - PL/SQL 源码目录
 * @param artifactsDir - .workflow-artifacts/{runId} 目录
 * @returns L3Summary
 *
 * 输入:
 *   - sourceDir/**/*.sql                   PL/SQL 源文件（提取 SQL 语句/表名/控制流）
 *   - projectDir/src/main/resources/*.xml  MyBatis XML（提取映射/表名）
 *   - projectDir/src/main/java/*.java      Java 源文件（提取控制流/异常处理）
 *   - artifactsDir/inventory-index.json    子程序清单（用于映射覆盖率）
 *
 * 输出:
 *   - l3-summary.json
 */
export function evaluateL3(
  projectDir: string,
  sourceDir: string,
  artifactsDir: string,
): L3Summary {

  // ── 1. SQL 覆盖率 ──
  // 从 PL/SQL 中按类型统计 SQL 语句
  const plsqlSql = {
    select: countPattern(sourceDir, /^\s*SELECT\b/im),
    insert: countPattern(sourceDir, /^\s*INSERT\s+INTO\b/im),
    update: countPattern(sourceDir, /^\s*UPDATE\b/im),
    delete: countPattern(sourceDir, /^\s*DELETE\b/im),
    merge:  countPattern(sourceDir, /^\s*MERGE\b/im),
  }
  plsqlSql["total"] = Object.values(plsqlSql).reduce((a, b) => a + b, 0)

  // 从 MyBatis XML 中统计映射
  const mybatisXml = {
    select: countXmlTag(projectDir, "select"),
    insert: countXmlTag(projectDir, "insert"),
    update: countXmlTag(projectDir, "update"),
    delete: countXmlTag(projectDir, "delete"),
  }
  mybatisXml["total"] = Object.values(mybatisXml).reduce((a, b) => a + b, 0)

  const sqlCoverageScore = plsqlSql.total > 0
    ? Math.min(100, Math.round(mybatisXml.total / plsqlSql.total * 100))
    : 0

  // ── 2. 表级覆盖率 ──
  const plsqlTables = extractTableNames(sourceDir, /\.(sql|pks|pkb)$/)
  const mybatisTables = extractTableNames(
    join(projectDir, "src", "main", "resources"), /\.xml$/,
  )
  const uncoveredTables = plsqlTables.filter(t => !mybatisTables.has(t))
  const tableCoverageScore = plsqlTables.length > 0
    ? Math.round((plsqlTables.length - uncoveredTables.length) / plsqlTables.length * 100)
    : 0

  // ── 3. 子程序映射覆盖率 ──
  const indexFile = join(artifactsDir, "inventory-index.json")
  let totalSubprograms = 0
  let mappedSubprograms = 0
  const unmappedList: string[] = []

  if (existsSync(indexFile)) {
    const index = JSON.parse(readFileSync(indexFile, "utf-8"))
    const allSubs: string[] = index.packages?.flatMap(
      (p: any) => p.procedures?.map((pr: any) => pr.name) ?? []
    ) ?? []
    totalSubprograms = allSubs.length

    // 扫描 Java 方法名，做 snake_case → camelCase 近似匹配
    const javaMethods = extractJavaMethodNames(join(projectDir, "src", "main", "java"))
    for (const sub of allSubs) {
      const camel = sub.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
      if (javaMethods.some(m => m.toLowerCase().includes(camel.toLowerCase()))) {
        mappedSubprograms++
      } else {
        unmappedList.push(sub)
      }
    }
  }

  const subprogramScore = totalSubprograms > 0
    ? Math.round(mappedSubprograms / totalSubprograms * 100)
    : 0

  // ── 4. 异常映射匹配度 ──
  const plsqlExceptions = countPattern(sourceDir, /EXCEPTION\s+WHEN\b/i)
  const javaCatches = countPattern(join(projectDir, "src", "main", "java"), /catch\s*\(/)
  const plsqlRaises = countPattern(sourceDir, /RAISE_APPLICATION_ERROR/i)
  const javaThrows = countPattern(join(projectDir, "src", "main", "java"), /throw\s+new/)

  let exceptionScore = 100
  if (plsqlExceptions > 0) {
    const ratio = javaCatches / plsqlExceptions
    const deviation = Math.abs(ratio - 1)
    exceptionScore = Math.max(0, Math.round((1 - deviation) * 100))
  }

  // ── 5. 控制流结构匹配 ──
  const plsqlCF = {
    if: countPattern(sourceDir, /^\s*IF\b/im),
    loop: countPattern(sourceDir, /^\s*(FOR|WHILE|LOOP)\b/im),
    return: countPattern(sourceDir, /^\s*RETURN\b/im),
  }
  const javaCF = {
    if: countPattern(join(projectDir, "src", "main", "java"), /^\s*if\s*\(/m),
    loop: countPattern(join(projectDir, "src", "main", "java"), /^\s*(for|while)\s*\(/m),
    return: countPattern(join(projectDir, "src", "main", "java"), /^\s*return\b/m),
  }
  const cosineSim = cosineSimilarity(
    [plsqlCF.if, plsqlCF.loop, plsqlCF.return],
    [javaCF.if, javaCF.loop, javaCF.return],
  )
  const controlFlowScore = Math.round(cosineSim * 100)

  // ── 综合评分 ──
  const total = Math.round(
    sqlCoverageScore     * 0.25 +
    tableCoverageScore   * 0.25 +
    subprogramScore      * 0.25 +
    exceptionScore       * 0.125 +
    controlFlowScore     * 0.125
  )

  return {
    scores: {
      sqlCoverage: sqlCoverageScore,
      tableCoverage: tableCoverageScore,
      subprogramCoverage: subprogramScore,
      exceptionMapping: exceptionScore,
      controlFlow: controlFlowScore,
      total,
    },
    details: {
      plsqlStatements: plsqlSql,
      mybatisMappings: mybatisXml,
      plsqlTables: [...plsqlTables],
      mybatisTables: [...mybatisTables],
      uncoveredTables,
      totalSubprograms,
      mappedSubprograms,
      unmappedSubprograms: unmappedList,
      plsqlExceptions,
      javaCatches,
      plsqlRaises,
      javaThrows,
      controlFlowVectors: {
        plsql: plsqlCF,
        java: javaCF,
        cosineSimilarity: Math.round(cosineSim * 1000) / 1000,
      },
    },
  }
}

/** 余弦相似度 */
function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((s, v, i) => s + v * b[i], 0)
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0))
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0))
  return magA > 0 && magB > 0 ? dot / (magA * magB) : 0
}
```

**预期运行效果**（mfg_erp_sql_tiny）：

```json
{
  "scores": {
    "sqlCoverage": 87,
    "tableCoverage": 95,
    "subprogramCoverage": 93,
    "exceptionMapping": 89,
    "controlFlow": 91,
    "total": 91
  },
  "details": {
    "plsqlStatements": { "select": 18, "insert": 6, "update": 4, "delete": 1, "merge": 2, "total": 31 },
    "mybatisMappings": { "select": 16, "insert": 5, "update": 4, "delete": 1, "total": 26 },
    "plsqlTables": ["t_item", "t_error_log", "t_bom_header"],
    "uncoveredTables": ["t_app_param"],
    "totalSubprograms": 15,
    "mappedSubprograms": 14,
    "unmappedSubprograms": ["archive_before"],
    "plsqlExceptions": 8,
    "javaCatches": 7,
    "plsqlRaises": 4,
    "javaThrows": 5,
    "controlFlowVectors": {
      "plsql": { "if": 18, "loop": 4, "return": 8 },
      "java":  { "if": 20, "loop": 3, "return": 9 },
      "cosineSimilarity": 0.987
    },
    "measurementCases": [
      {
        "subprogram": "fn_abc_class",
        "status": "passed",
        "checks": {
          "sql_statements": { "expected": { "select": 0 }, "actual": { "select": 0 }, "pass": true },
          "control_flow": { "expected": { "if": 3, "return": 4 }, "actual": { "if": 3, "return": 4 }, "pass": true },
          "type_mappings": { "total": 4, "violations": 0, "pass": true }
        }
      },
      {
        "subprogram": "get_item",
        "status": "passed",
        "checks": {
          "sql_statements": { "expected": { "select": 1 }, "actual": { "select": 1 }, "pass": true },
          "exceptions": { "expected": "NO_DATA_FOUND→EmptyResultDataAccessException", "actual": "matched", "pass": true },
          "type_mappings": { "total": 2, "violations": 0, "pass": true }
        }
      },
      {
        "subprogram": "bulk_receive",
        "status": "failed",
        "checks": {
          "sql_statements": { "expected": { "insert": 1, "merge": 1 }, "actual": { "insert": 1, "merge": 0 }, "pass": false },
          "special_constructs": { "FORALL SAVE EXCEPTIONS": "pass", "MERGE INTO": "fail - 未翻译" }
        }
      }
    ]
  }
}
```

### 5.4 L4: 行为等价验证

> **实现详见** `.opencode/command/sql2java_evaluation.md` → L4 段落

**核心逻辑**：读取 YAML 测试用例，按三级降级策略执行行为等价验证：

1. **有 PostgreSQL** → 全量 pg_call + java_call 双端比对（原有逻辑不变）
2. **无 PostgreSQL** → 按 `db_level` 字段降级：
   - `pure_java` → 直接调用 Java 方法比对 expected_return
   - `h2_compatible` → Spring Boot Test + H2 内存库执行 java_call
   - `pg_only` → 标记 `skipped_pg_only`

#### 三级降级策略

```text
│ 级别 1: pure_java — 纯 Java 测试（无需任何数据库）         │
│   db_level = "pure_java" 的用例                            │
│   → 直接调用 java_call，比对 expected_return              │
├───────────────────────────────────────────────────────────┤
│ 级别 2: h2_compatible — H2 内存库集成测试                  │
│   db_level = "h2_compatible" 的用例                        │
│   → 注入 H2 schema + setup.sql → Spring Boot Test 运行    │
│   → 比对 expected 中的 return_fields / exception 等        │
├───────────────────────────────────────────────────────────┤
│ 级别 3: pg_only — 仅 PostgreSQL 可测                      │
│   db_level = "pg_only" 的用例                              │
│   → 有 PG: 全量比对                                        │
│   → 无 PG: skipped_pg_only                                 │
└───────────────────────────────────────────────────────────┘
```

#### 用例 db_level 标注

每个 YAML 文件新增 `db_level` 字段：

```yaml
test_suite: fn_abc_class
description: ABC 分类函数行为等价验证
db_level: pure_java          # ← 新增: pure_java / h2_compatible / pg_only
source_file: resources/mfg_erp_sql_tiny/func/fn_abc_class.sql
java_class: com.erp.util.AbcClassUtil
java_method: classify

setup:
  sql: |
    -- 无需额外数据初始化，纯计算函数

cases:
  - name: A类_cumPct低于80%
    pg_call: "SELECT fn_abc_class(0.50)"
    java_call: "AbcClassUtil.classify(new BigDecimal(\"0.50\"))"
    expected_return: "A"

  - name: B类_cumPct在80%-95%之间
    pg_call: "SELECT fn_abc_class(0.88)
    java_call: "AbcClassUtil.classify(new BigDecimal(\"0.88\"))"
    expected_return: "B"

  - name: C类_cumPct高于95%
    pg_call: "SELECT fn_abc_class(0.98)
    java_call: "AbcClassUtil.classify(new BigDecimal(\"0.98\"))"
    expected_return: "C"

  - name: NULL输入返回NULL
    pg_call: "SELECT fn_abc_class(NULL)
    java_call: "AbcClassUtil.classify(null)"
    expected_return: null

  - name: 边界值_刚好80%
    pg_call: "SELECT fn_abc_class(0.80)
    java_call: "AbcClassUtil.classify(new BigDecimal(\"0.80\"))"
    expected_return: "A"

  - name: 自定义阈值
    pg_call: "SELECT fn_abc_class(0.70, 0.70, 0.90)
    java_call: "AbcClassUtil.classify(new BigDecimal(\"0.70\"), new BigDecimal(\"0.70\"), new BigDecimal(\"0.90\"))"
    expected_return: "A"
```

**核心逻辑**（三级降级）：

```typescript
// L4 行为等价验证逻辑（伪代码参考 — 三级降级策略）
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import type { L4Summary, DegradedInfo } from "./types"

type DbLevel = "pure_java" | "h2_compatible" | "pg_only"

/**
 * 执行 L4 行为等价验证（支持三级降级）
 *
 * @param testCasesDir - evaluation/equivalence-cases/ 目录
 * @param projectDir   - Java 项目目录
 * @param sourceDir    - PL/SQL 源码目录（用于动态生成 H2 Schema）
 * @param dbConfig     - PostgreSQL 连接配置（可选，有则全量比对）
 * @returns L4Summary
 */
export function evaluateL4(
  testCasesDir: string,
  projectDir: string,
  sourceDir: string,
  dbConfig?: { host: string; port: number; service: string; user: string; password: string },
): L4Summary {
  const caseResults: L4Summary["details"]["caseResults"] = []
  let pgAvailable = !!dbConfig

  // ── 检测 PostgreSQL 可用性 ──
  if (!dbConfig) {
    try {
      execSync("psql --version", { timeout: 5000 })
      // psql 可执行但不一定连接成功，暂不启用全量模式
      pgAvailable = false
    } catch {
      pgAvailable = false
    }
  }

  const yamlFiles = readdirSync(testCasesDir).filter(f => f.endsWith(".yaml"))
  const degradedInfo: DegradedInfo = {
    level1_pureJavaCases: 0,
    level2_h2Cases: 0,
    level3_pgOnlySkipped: 0,
    pgAvailable,
  }

  for (const file of yamlFiles) {
    const suite = parseYaml(readFileSync(join(testCasesDir, file), "utf-8"))
    const dbLevel: DbLevel = suite.db_level ?? "h2_compatible"  // 默认 h2_compatible

    for (const testCase of suite.cases) {
      // ── 有 PG: 全量比对 ──
      if (pgAvailable && dbConfig) {
        const pgOutput = executePgCall(testCase.pg_call, dbConfig)
        const javaOutput = executeJavaCall(testCase.java_call, projectDir)
        const diffs = compareResults(pgOutput, javaOutput, testCase.expected_return)
        caseResults.push({
          suite: suite.test_suite,
          caseName: testCase.name,
          status: diffs.length === 0 ? "passed" : "failed",
          mode: "full_pg",
          oracleOutput: pgOutput,
          javaOutput,
          diffs: diffs.length > 0 ? diffs : undefined,
        })
        continue
      }

      // ── 无 PG: 三级降级 ──
      if (dbLevel === "pg_only") {
        degradedInfo.level3_pgOnlySkipped++
        caseResults.push({
          suite: suite.test_suite,
          caseName: testCase.name,
          status: "skipped_pg_only",
          mode: "pg_only",
        })
        continue
      }

      if (dbLevel === "pure_java") {
        degradedInfo.level1_pureJavaCases++
        // 生成纯 Java 测试 → 调用方法 → 比对 expected_return
        const javaOutput = executePureJavaCall(
          suite.java_class, suite.java_method, testCase.java_call, projectDir
        )
        const diffs = compareWithExpected(javaOutput, testCase.expected_return ?? testCase.expected)
        caseResults.push({
          suite: suite.test_suite,
          caseName: testCase.name,
          status: diffs.length === 0 ? "passed" : "failed",
          mode: "pure_java",
          javaOutput,
          diffs: diffs.length > 0 ? diffs : undefined,
        })
        continue
      }

      if (dbLevel === "h2_compatible") {
        degradedInfo.level2_h2Cases++
        // 注入 H2 schema + setup.sql → Spring Boot Test → 比对
        const javaOutput = executeH2Call(
          suite, testCase, sourceDir, projectDir
        )
        const diffs = compareWithExpected(javaOutput, testCase.expected ?? testCase.expected_return)
        caseResults.push({
          suite: suite.test_suite,
          caseName: testCase.name,
          status: diffs.length === 0 ? "passed" : "failed",
          mode: "h2",
          javaOutput,
          diffs: diffs.length > 0 ? diffs : undefined,
        })
        continue
      }
    }
  }

  const total = caseResults.length
  const passed = caseResults.filter(r => r.status === "passed").length
  const failed = caseResults.filter(r => r.status === "failed").length
  const skippedPgOnly = caseResults.filter(r => r.status === "skipped_pg_only").length
  const executable = total - skippedPgOnly

  return {
    scores: {
      equivalenceRate: executable > 0 ? Math.round(passed / executable * 100) : 0,
    },
    executionMode: pgAvailable ? "full_pg" : "degraded_h2",
    degradedInfo: pgAvailable ? null : degradedInfo,
    totalCases: total,
    passedCases: passed,
    failedCases: failed,
    skippedCases: skippedPgOnly,
    skippedDetail: {
      pg_only: caseResults
        .filter(r => r.status === "skipped_pg_only")
        .map(r => `${r.suite}: ${r.caseName}`),
    },
    details: { caseResults },
  }
}

/** 纯 Java 调用：无需数据库，直接 new 对象调用方法 */
function executePureJavaCall(
  javaClass: string, javaMethod: string, javaCall: string, projectDir: string
): unknown {
  // Agent 生成 JUnit 测试类 → mvn test → 解析 surefire 报告
  // 参见 .opencode/command/sql2java_evaluation.md → Step A
}

/** H2 集成测试调用：注入 H2 schema → Spring Boot Test → 比对 */
function executeH2Call(
  suite: any, testCase: any, sourceDir: string, projectDir: string
): unknown {
  // 1. 从 sourceDir/../schema/ 动态读取 Oracle 建表 SQL → 适配为 H2 → 写入 reportDir/h2-schema.sql
  // 2. 复制生成的 h2-schema.sql 到 src/test/resources/
  // 3. 注入 application-test.yml（H2 MODE=Oracle 配置）
  // 4. 适配 setup.sql → H2 语法（ON CONFLICT → MERGE INTO 等）
  // 5. 生成 @SpringBootTest 测试类 → mvn test
  // 6. 清理注入的临时文件
  // 参见 .opencode/command/sql2java_evaluation.md → Step B
}

/** 比对 Java 结果与预期值（支持 expected_return 和 expected 复合断言） */
function compareWithExpected(
  javaOutput: unknown, expected: unknown
): Array<{field: string; expected: unknown; actual: unknown}> {
  // 宽容比较规则:
  // - BigDecimal 忽略 scale (10.50 == 10.5)
  // - NULL ≈ null ≈ 空串
  // - 浮点容忍 0.0001 误差
  // - 有 tolerance 字段时使用指定精度
  // - return_fields: 逐字段比对
  // - exception: 检查异常类型名
  // 参见 evaluateL4 原始 compareResults
}

/** 宽容比较：处理 BigDecimal scale、NULL/空串、Date 格式差异 */
function compareResults(oracle: unknown, java: unknown, expected: unknown): Array<{field: string; expected: unknown; actual: unknown}> {
  const diffs: Array<{field: string; expected: unknown; actual: unknown}> = []

  // NULL vs null 等价
  if (oracle === null && java === null) return diffs
  if (oracle === "" && java === null) return diffs  // Oracle 空串 = NULL

  // BigDecimal: 忽略 scale (10.50 == 10.5)
  if (typeof oracle === "number" && typeof java === "number") {
    if (Math.abs(oracle - java) > 0.0001) {
      diffs.push({ field: "return", expected: oracle, actual: java })
    }
    return diffs
  }

  // 字符串直接比较
  if (String(oracle) !== String(java)) {
    diffs.push({ field: "return", expected: oracle, actual: java })
  }

  return diffs
}
```

---

## 六、综合报告生成

> **实现详见** `.opencode/command/sql2java_evaluation.md` → 综合报告生成段落

```typescript
// 综合报告生成逻辑（伪代码参考）
import type { EvalReport, L1Metrics, L2Summary, L3Summary, L4Summary } from "./types"

/**
 * 生成综合评估报告（Markdown + JSON）
 *
 * 输入: L1Metrics, L2Summary, L3Summary, L4Summary（各层可为 null）
 * 输出:
 *   - {outputDir}/eval-report.json  机器可读
 *   - {outputDir}/eval-report.md    人类可读
 */
export function generateReport(
  l1: L1Metrics | null,
  l2: L2Summary | null,
  l3: L3Summary | null,
  l4: L4Summary | null,
  meta: { date: string; runId: string; sourcePath: string; projectPath: string; datasetLevel: string },
): EvalReport {

  const weights = { l1: 0.10, l2: 0.30, l3: 0.35, l4: 0.25 }

  // 各层得分（null 层不计入，重新分配权重）
  const layerScores: Array<{ key: string; score: number; weight: number }> = []
  if (l1) layerScores.push({ key: "l1", score: l1.firstPassRate ?? 50, weight: weights.l1 })
  if (l2) layerScores.push({ key: "l2", score: l2.scores.total, weight: weights.l2 })
  if (l3) layerScores.push({ key: "l3", score: l3.scores.total, weight: weights.l3 })
  if (l4) layerScores.push({ key: "l4", score: l4.scores.equivalenceRate, weight: weights.l4 })

  const totalWeight = layerScores.reduce((s, l) => s + l.weight, 0)
  const totalScore = totalWeight > 0
    ? Math.round(layerScores.reduce((s, l) => s + l.score * l.weight / totalWeight, 0) * 10) / 10
    : 0

  const grade = totalScore >= 95 ? "A+" : totalScore >= 85 ? "A" : totalScore >= 70 ? "B" : totalScore >= 50 ? "C" : "D"

  const report: EvalReport = {
    ...meta,
    layers: { l1, l2, l3, l4 },
    totalScore,
    grade,
    weights,
  }

  // 生成 Markdown
  const md = generateMarkdownReport(report)
  return { ...report, _markdown: md }
}

function generateMarkdownReport(r: EvalReport): string {
  const lines: string[] = [
    `# SQL2Java 转译质量评估报告`,
    "",
    `- **日期**: ${r.date}`,
    `- **Run ID**: ${r.runId}`,
    `- **数据集**: ${r.datasetLevel}`,
    `- **SQL 源码**: \`${r.sourcePath}\``,
    `- **Java 项目**: \`${r.projectPath}\``,
    "",
    `## 综合评分: ${r.totalScore}/100 (${r.grade})`,
    "",
    `| 层级 | 得分 | 权重 | 加权分 |`,
    `|------|------|------|--------|`,
  ]

  if (r.layers.l1) {
    const score = r.layers.l1.firstPassRate ?? 50
    lines.push(`| L1 转译效率 | ${score}/100 | ${Math.round(r.weights.l1*100)}% | ${Math.round(score * r.weights.l1 * 10) / 10} |`)
  }
  if (r.layers.l2) {
    lines.push(`| L2 代码质量 | ${r.layers.l2.scores.total}/100 | ${Math.round(r.weights.l2*100)}% | ${Math.round(r.layers.l2.scores.total * r.weights.l2 * 10) / 10} |`)
  }
  if (r.layers.l3) {
    lines.push(`| L3 语义分析 | ${r.layers.l3.scores.total}/100 | ${Math.round(r.weights.l3*100)}% | ${Math.round(r.layers.l3.scores.total * r.weights.l3 * 10) / 10} |`)
  }
  if (r.layers.l4) {
    lines.push(`| L4 行为等价 | ${r.layers.l4.scores.equivalenceRate}/100 | ${Math.round(r.weights.l4*100)}% | ${Math.round(r.layers.l4.scores.equivalenceRate * r.weights.l4 * 10) / 10} |`)
  }

  // L1 详情
  if (r.layers.l1) {
    lines.push("", "## L1 转译效率", "")
    lines.push(`| 指标 | 值 |`)
    lines.push(`|------|-----|`)
    lines.push(`| 总费用 | $${r.layers.l1.totalCost} |`)
    lines.push(`| 单子程序成本 | $${r.layers.l1.costPerSubprogram ?? "N/A"} |`)
    lines.push(`| 吞吐量 | ${r.layers.l1.throughputPerHour ?? "N/A"} 子程序/小时 |`)
    lines.push(`| Fix 循环 | ${r.layers.l1.fixCycles} 次 |`)
    lines.push(`| Fix 成本占比 | ${Math.round(r.layers.l1.fixCostRatio * 1000) / 10}% |`)
  }

  // L2 详情
  if (r.layers.l2) {
    lines.push("", "## L2 代码质量", "")
    lines.push(`| 指标 | 得分 | 详情 |`)
    lines.push(`|------|------|------|`)
    const d = r.layers.l2.details
    lines.push(`| 编译 | ${r.layers.l2.scores.compile}/100 | ${d.compileSuccess ? "通过" : `${d.compileErrors} 个错误`} |`)
    lines.push(`| 测试 | ${r.layers.l2.scores.test}/100 | ${d.passedTests}/${d.totalTests} 通过 |`)
    lines.push(`| TODO 残留 | ${r.layers.l2.scores.todo}/100 | [translate]:${d.todoTranslate}, [test]:${d.todoTest} |`)
    lines.push(`| 规约合规 | ${r.layers.l2.scores.style}/100 | ${d.checkstyleViolations} 处违规 |`)
    lines.push(`| 覆盖率 | ${r.layers.l2.scores.coverage}/100 | ${d.coveragePct ?? "N/A"}% |`)
    lines.push(`| Java 8 兼容 | ${r.layers.l2.scores.java8}/100 | ${d.java9Violations} 处违规 |`)
  }

  // L3 详情
  if (r.layers.l3) {
    lines.push("", "## L3 语义分析", "")
    const d = r.layers.l3.details
    lines.push(`| 指标 | 得分 | 详情 |`)
    lines.push(`|------|------|------|`)
    lines.push(`| SQL 覆盖率 | ${r.layers.l3.scores.sqlCoverage}/100 | MyBatis ${d.mybatisMappings.total}/${d.plsqlStatements.total} |`)
    lines.push(`| 表覆盖率 | ${r.layers.l3.scores.tableCoverage}/100 | ${d.uncoveredTables.length > 0 ? `未覆盖: ${d.uncoveredTables.join(", ")}` : "全部覆盖"} |`)
    lines.push(`| 子程序映射 | ${r.layers.l3.scores.subprogramCoverage}/100 | ${d.mappedSubprograms}/${d.totalSubprograms}${d.unmappedSubprograms.length > 0 ? `，未映射: ${d.unmappedSubprograms.join(", ")}` : ""} |`)
    lines.push(`| 异常映射 | ${r.layers.l3.scores.exceptionMapping}/100 | catch ${d.javaCatches} vs EXCEPTION ${d.plsqlExceptions} |`)
    lines.push(`| 控制流 | ${r.layers.l3.scores.controlFlow}/100 | 余弦相似度 ${d.controlFlowVectors.cosineSimilarity} |`)
  }

  // 改进建议
  lines.push("", "## 改进建议", "")
  const suggestions = generateSuggestions(r)
  if (suggestions.length === 0) {
    lines.push("无。转译质量良好。")
  } else {
    suggestions.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
  }

  return lines.join("\n")
}

function generateSuggestions(r: EvalReport): string[] {
  const suggestions: string[] = []

  if (r.layers.l2) {
    if (r.layers.l2.scores.compile === 0) suggestions.push("**编译失败**——这是最高优先级问题，所有后续指标均依赖编译通过")
    if (r.layers.l2.scores.test < 80) suggestions.push(`测试通过率仅 ${r.layers.l2.scores.test}%，可能存在系统性翻译错误`)
    if (r.layers.l2.details.todoTranslate > 5) suggestions.push(`[translate] TODO 残留 ${r.layers.l2.details.todoTranslate} 处，翻译不够完整`)
    if (r.layers.l2.details.java9Violations > 0) suggestions.push(`发现 ${r.layers.l2.details.java9Violations} 处 Java 9+ API 使用，违反 Java 8 兼容性要求`)
  }

  if (r.layers.l3) {
    if (r.layers.l3.details.uncoveredTables.length > 0) {
      suggestions.push(`以下表在 MyBatis 中未覆盖: ${r.layers.l3.details.uncoveredTables.join(", ")}`)
    }
    if (r.layers.l3.details.unmappedSubprograms.length > 0) {
      suggestions.push(`以下子程序未找到对应 Java 方法: ${r.layers.l3.details.unmappedSubprograms.join(", ")}`)
    }
    if (r.layers.l3.scores.sqlCoverage < 85) {
      suggestions.push(`SQL 覆盖率仅 ${r.layers.l3.scores.sqlCoverage}%，有 ${r.layers.l3.details.plsqlStatements.total - r.layers.l3.details.mybatisMappings.total} 条 SQL 未映射`)
    }
  }

  return suggestions
}
```

---

## 八、入口命令

> **实现详见** `.opencode/command/sql2java_evaluation.md`（完整 agent prompt）

调用方式：

```bash
/sql2java_evaluation [选项]
```

命令执行流程：自动推导 runId/sourceDir/outputDir → 按 `--layers` 依次执行 L1~L4 → 生成综合报告。

```typescript
// 入口调度逻辑（伪代码参考，实际由 sql2java_evaluation.md 命令驱动）
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { evaluateL1 } from "./l1-efficiency"
import { evaluateL2 } from "./l2-quality"
import { evaluateL3 } from "./l3-semantic"
import { evaluateL4 } from "./l4-equivalence"
import { generateReport } from "./report"

/**
 * 评估工具入口
 *
 * 用法（实际通过 /sql2java_evaluation 斜杠命令调用）:
 *   /sql2java_evaluation [选项]
 *
 * 所有参数可选，默认从 artifacts 自动推导:
 *   --output <dir>      Java 项目目录（默认从 scaffold.json 推导）
 *   --source <dir>      PL/SQL 源码目录（默认从 inventory-index.json 推导）
 *   --run-id <id>       工作流 runId（默认取最新）
 *   --layers <list>     逗号分隔：l1,l2,l3,l4（默认 l1,l2,l3）
 *   --layers <list>     l1,l2,l3,l4（默认 l1,l2,l3）
 *   --output <dir>      /sql2java 生成的 Java 项目目录
 */

// 解析参数
const args = process.argv.slice(2)
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  return idx >= 0 ? args[idx + 1] : undefined
}

// ── Step 1: 定位 runId ──
const artifactsDir = getArg("run-id")
  ? join(".workflow-artifacts", getArg("run-id")!)
  : findLatestArtifactsDir()

// ── Step 2: 从 artifacts 自动推导 sourceDir 和 outputDir ──
let sourceDir = getArg("source")
let outputDir = getArg("output")

if (!sourceDir) {
  const indexFile = join(artifactsDir, "inventory-index.json")
  if (!existsSync(indexFile)) {
    console.error("未找到 inventory-index.json，请通过 --source 手动指定")
    process.exit(1)
  }
  sourceDir = JSON.parse(readFileSync(indexFile, "utf-8")).sourcePath
}

if (!outputDir) {
  const scaffoldFile = join(artifactsDir, "scaffold.json")
  if (!existsSync(scaffoldFile)) {
    console.error("未找到 scaffold.json，请通过 --output 手动指定 Java 项目目录")
    process.exit(1)
  }
  outputDir = JSON.parse(readFileSync(scaffoldFile, "utf-8")).projectRoot
}

const layersStr = getArg("layers") ?? "l1,l2,l3,l4"

// 确定输出目录
const dateTag = new Date().toISOString().slice(0, 10) + "_" + new Date().toISOString().slice(11, 16).replace(":", "")
const outputDir = outputDirArg ?? join("evaluation", "baselines", `${dateTag}`)
mkdirSync(outputDir, { recursive: true })

console.log("╔══════════════════════════════════════════════════╗")
console.log("║     SQL2Java 转译质量评估                        ║")
console.log("╚══════════════════════════════════════════════════╝")
console.log("")
console.log(`  Java 项目: ${outputDir}`)
console.log(`  SQL 源码:  ${sourceDir}`)
console.log(`  Artifacts: ${artifactsDir}`)
console.log(`  层级:      ${[...layers].join(", ")}`)
console.log(`  输出:      ${outputDir}`)
console.log("")

// ── 执行各层评估 ──
let l1 = null, l2 = null, l3 = null, l4 = null

if (layers.has("l1")) {
  console.log("═══ L1: 转译效率度量 ═══")
  try {
    l1 = evaluateL1(artifactsDir)
    writeFileSync(join(outputDir, "l1-metrics.json"), JSON.stringify(l1, null, 2))
    console.log(`  ✅ 完成 → l1-metrics.json`)
  } catch (e: any) {
    console.log(`  ⚠️ 跳过: ${e.message}`)
  }
  console.log("")
}

if (layers.has("l2")) {
  console.log("═══ L2: 代码质量度量 ═══")
  try {
    l2 = evaluateL2(outputDir, sourceDir, reportDir)
    writeFileSync(join(outputDir, "l2-summary.json"), JSON.stringify(l2, null, 2))
    console.log(`  ✅ 完成 → l2-summary.json (总分: ${l2.scores.total}, 评级: ${l2.grade})`)
  } catch (e: any) {
    console.log(`  ⚠️ 失败: ${e.message}`)
  }
  console.log("")
}

if (layers.has("l3")) {
  console.log("═══ L3: 语义分析度量 ═══")
  try {
    l3 = evaluateL3(outputDir, sourceDir, artifactsDir)
    writeFileSync(join(outputDir, "l3-summary.json"), JSON.stringify(l3, null, 2))
    console.log(`  ✅ 完成 → l3-summary.json (总分: ${l3.scores.total})`)
  } catch (e: any) {
    console.log(`  ⚠️ 失败: ${e.message}`)
  }
  console.log("")
}

if (layers.has("l4")) {
  console.log("═══ L4: 行为等价度量 ═══")
  const testCasesDir = join("evaluation", "test-cases")
  if (existsSync(testCasesDir)) {
    try {
      l4 = evaluateL4(testCasesDir, outputDir)
      writeFileSync(join(outputDir, "l4-summary.json"), JSON.stringify(l4, null, 2))
      console.log(`  ✅ 完成 → l4-summary.json (通过率: ${l4.scores.equivalenceRate}%)`)
    } catch (e: any) {
      console.log(`  ⚠️ 失败: ${e.message}`)
    }
  } else {
    console.log(`  ⚠️ 跳过: ${testCasesDir} 不存在`)
  }
  console.log("")
}

// ── 生成综合报告 ──
console.log("═══ 生成综合报告 ═══")
const datasetLevel = sourceDir.includes("tiny") ? "tiny" : sourceDir.includes("mini") ? "mini" : "full"
const report = generateReport(l1, l2, l3, l4, {
  date: new Date().toISOString().slice(0, 10),
  runId: runId ?? "latest",
  sourcePath: sourceDir,
  projectPath: outputDir,
  datasetLevel,
})

writeFileSync(join(outputDir, "eval-report.json"), JSON.stringify(report, null, 2))
writeFileSync(join(outputDir, "eval-report.md"), (report as any)._markdown ?? "")

console.log(`  ✅ eval-report.json`)
console.log(`  ✅ eval-report.md`)
console.log("")
console.log("╔══════════════════════════════════════════════════╗")
console.log(`║  📊 综合评分: ${String(report.totalScore).padEnd(5)}/100 (${report.grade})${" ".repeat(Math.max(0, 20 - String(report.totalScore).length))}║`)
console.log("╚══════════════════════════════════════════════════╝")
console.log("")
console.log(`完整结果: ${reportDir}/`)

// ── 辅助函数 ──
function findLatestArtifactsDir(): string {
  const base = ".workflow-artifacts"
  if (!existsSync(base)) throw new Error("未找到 .workflow-artifacts/ 目录")
  const dirs = require("node:fs").readdirSync(base)
    .filter((d: string) => d.startsWith("run-"))
    .sort()
    .reverse()
  if (dirs.length === 0) throw new Error(".workflow-artifacts/ 下无 run-* 目录")
  return join(base, dirs[0])
}
```

---

## 九、Checkstyle 配置

**文件**：`evaluation/quality-rules/checkstyle.xml`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE module PUBLIC "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN"
    "https://checkstyle.org/dtds/configuration_1_3.dtd">
<!--
  映射 .opencode/docs/java-code-spec.md 的【强制】条款
-->
<module name="Checker">
    <property name="severity" value="warning"/>
    <property name="charset" value="UTF-8"/>

    <module name="TreeWalker">
        <!-- (一) 命名: UpperCamelCase 类名 -->
        <module name="TypeName">
            <property name="format" value="^[A-Z][a-zA-Z0-9]*(DO|BO|DTO|VO|Impl|Service|Mapper|Enum|Exception|Test)?$"/>
        </module>
        <!-- (一) 命名: lowerCamelCase 方法名 -->
        <module name="MethodName">
            <property name="format" value="^[a-z][a-zA-Z0-9]*$"/>
        </module>
        <!-- (一) 命名: 常量全大写 -->
        <module name="ConstantName">
            <property name="format" value="^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$|^log(ger)?$"/>
        </module>
        <!-- (一) 命名: 包名全小写 -->
        <module name="PackageName">
            <property name="format" value="^[a-z]+(\.[a-z][a-z0-9]*)*$"/>
        </module>
        <!-- (一) 布尔属性无 is 前缀 -->
        <module name="RegexpSinglelineJava">
            <property name="format" value="private\s+(boolean|Boolean)\s+is[A-Z]"/>
            <property name="message" value="布尔属性不要加 is 前缀（java-code-spec 1.8）"/>
            <property name="ignoreComments" value="true"/>
        </module>
        <!-- (三) 行宽 120 -->
        <module name="LineLength">
            <property name="max" value="120"/>
            <property name="ignorePattern" value="^package|^import|href|http"/>
        </module>
        <!-- (三) 4 空格缩进 -->
        <module name="Indentation">
            <property name="basicOffset" value="4"/>
            <property name="caseIndent" value="4"/>
        </module>
        <!-- (四) @Override 注解 -->
        <module name="MissingOverride"/>
        <!-- (七) 禁止空 catch -->
        <module name="EmptyCatchBlock">
            <property name="exceptionVariableName" value="expected|ignore"/>
        </module>
    </module>
</module>
```

---

## 十、运行方式

评估通过 OpenCode 斜杠命令执行，无需安装额外依赖。Agent 通过 bash 工具调用 `mvn`、`grep`、`find` 等跨平台命令。

### 快速回归（tiny 数据集，~10 分钟）

```bash
# 1. 先转译
/sql2java resources/mfg_erp_sql_tiny

# 2. 再评估（无需传参，自动推导）
/sql2java_evaluation
```

### 中等评估（mini 数据集，~40 分钟）

```bash
/sql2java resources/mfg_erp_sql_mini

/sql2java_evaluation
```

### 完整评估（full 数据集，~2-3 小时，含 L4）

```bash
/sql2java resources/mfg_erp_sql

/sql2java_evaluation --layers l1,l2,l3,l4
```

### 多次运行对比（改前 vs 改后）

```bash
# 改前：转译 + 评估
/sql2java resources/mfg_erp_sql_tiny
/sql2java_evaluation
# 报告保存到 .opencode/evaluation/sql2java/baselines/run-20260612-143022/

# 修改 prompt 后，重新转译 + 评估
/sql2java resources/mfg_erp_sql_tiny
/sql2java_evaluation
# 报告保存到 .opencode/evaluation/sql2java/baselines/run-20260612-160530/

# 手动对比两个目录下的 eval-report.md
```

---

## 十一、实施路线图（人天精确）

### Phase 1: 第一周（L1 + L2 + 命令框架）

| 天 | 任务 | 输入 | 产出 | 验收标准 |
|----|------|------|------|---------|
| D1 | 创建目录结构 `.opencode/evaluation/sql2java/{config,test-cases,baselines}/` | — | 目录存在 | `ls` 确认 |
| D1 | 编写 `.opencode/command/sql2java_evaluation.md` 命令定义 | 本文档 | 斜杠命令可调用 | `/sql2java_evaluation --help` 显示用法 |
| D1 | 实现 L1 逻辑（命令中 L1 段落）：读取 run-metrics.json 计算效率指标 | `run-metrics.json` | `l1-metrics.json` | 对已有 run 能提取指标 |
| D2 | 实现 L2 逻辑：编译 + 测试 + LOC + TODO 扫描 | Java 项目 + SQL 源码 | `l2-summary.json` v1 | 4 项基础指标能输出 |
| D2-3 | 编写 `.opencode/evaluation/sql2java/quality-rules/checkstyle.xml` | `java-code-spec.md` | `checkstyle.xml` | `mvn checkstyle:check` 能运行 |
| D3 | 完善 L2 逻辑：+Checkstyle +JaCoCo +Java 8 合规检查 | checkstyle.xml | `l2-summary.json` 完整版 | 7 项指标全部输出 |
| D4 | 实现综合报告生成逻辑（读取 L1+L2 JSON → 加权评分 → Markdown） | L1+L2 产出 | `eval-report.json` + `eval-report.md` | 一键出报告 |
| D5 | 用 `mfg_erp_sql_tiny` 跑完整转译 + 评估，建立首个基线 | 转译结果 | `baselines/` 首个数据点 | 端到端验证通过 |

### Phase 2: 第二周（L3）

| 天 | 任务 | 输入 | 产出 |
|----|------|------|------|
| D1 | 实现 L3 逻辑：SQL 覆盖率 + 表覆盖率 | SQL 源码 + MyBatis XML | L3 v1 |
| D2 | 增加子程序映射覆盖率 + 异常映射 | inventory-index.json + Java 源码 | L3 v2 |
| D3 | 增加控制流结构匹配（余弦相似度）+ 测量用例比对 | measurement-cases YAML | L3 完整版 |
| D4 | 串联 L1+L2+L3，用 tiny 数据集端到端验证 | 全部 | 一键出综合报告 |
| D5 | 用 mini 数据集验证，确认报告完整 | mini 转译结果 | 第二个基线数据点 |

### Phase 3: 第三周起（L4 行为等价）

| 天 | 任务 | 产出 |
|----|------|------|
| D1-2 | 编写首批 YAML 测试用例（fn_abc_class、log_error、get_item） | 3 个 P0/P1 用例 |
| D3-5 | 搭建 PostgreSQL 测试环境，扩充测试用例到全部 13 个 | L4 可运行 |
| D6-7 | CI 集成：prompt 改动自动跑 tiny 评估 | CI pipeline |
| D8 | 编写 `evaluation/README.md` | 使用文档 |

---

## 十二、典型使用场景

### 场景 1: prompt 调试快速回归

```bash
# 1. 修改 .opencode/agent/translator.md 中的映射表

# 2. 用 tiny 数据集快速验证（~10 分钟）
/sql2java resources/mfg_erp_sql_tiny

# 3. 运行评估（自动推导，报告按 runId 存储）
/sql2java_evaluation

# 4. 查看 eval-report.md，与上次运行的报告手动对比
#   关注 L3.sqlCoverage、L2.test 等关键指标变化
```

### 场景 2: 模型切换评估

```bash
# 1. 当前模型跑一次
/sql2java resources/mfg_erp_sql_mini
/sql2java_evaluation
# → 报告保存到 .opencode/evaluation/sql2java/baselines/run-20260612-143022/

# 2. 切换模型后跑一次
/sql2java resources/mfg_erp_sql_mini
/sql2java_evaluation
# → 报告保存到 .opencode/evaluation/sql2java/baselines/run-20260612-160530/
# 手动对比两个 runId 目录下的 eval-report.md
```

### 场景 3: 发布质量门禁

```bash
# 完整评估（含 L4 行为等价，需要 PostgreSQL 环境）
/sql2java resources/mfg_erp_sql
/sql2java_evaluation --layers l1,l2,l3,l4

# 检查 eval-report.md 中的综合评分
# ≥85 → A 级，可以发布
# <85 → 需要修复后重新评估
```
