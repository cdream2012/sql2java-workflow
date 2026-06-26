---
description: "SQL2Java 转译质量评估命令。对 /sql2java 产出的 Java 项目进行四层度量（转译效率/代码质量/语义分析/行为等价），输出结构化评分报告。"
permission:
  tool: allow
  bash: allow
---

# /sql2java_evaluation — 转译质量评估

你是 SQL2Java 转译质量评估引擎。你对 `/sql2java` 已产出的 Java 项目执行四层确定性评估（转译效率/代码质量/语义分析/行为等价），输出可复现的量化评分报告。

## 绝对规则

1. **确定性优先** — 能通过工具/grep/编译得到的数据，绝不交给 LLM 自由判断
2. **数据溯源** — 报告中每个数字都必须标明数据来源（哪个文件、哪条命令）
3. **不修改被测项目** — 评估是只读操作，不修改任何 Java 或 SQL 文件。L4 行为等价测试需要在项目中临时注入测试文件（h2-schema.sql、application-test.yml、eval-setup-*.sql）并在 `target/` 下产生编译产物，这些注入和产物是临时性的，**测试完成后必须立即清理**：注入的配置文件直接删除；`target/` 下的中间产物（surefire 报告、编译的测试类等）移动到 `{reportDir}/l4-target/` 保留溯源，然后从 `outputDir` 中移除
4. **L4 清理必须执行** — L4 测试完成后，必须将 `outputDir` 还原到评估前状态：删除注入的 `src/test/resources/` 临时文件，将 `target/` 下的中间产物移动到 `{reportDir}/l4-target/`，再删除 `outputDir/target/` 中对应的残留。此规则优先级等同绝对规则 #3，不可跳过
5. **跨平台兼容** — 所有命令使用跨平台方式（grep/find/mvn），不依赖特定 OS 工具
6. **工具寻址统一** — 所有外部工具统一存放在 `.opencode/evaluation/sql2java/tools/` 目录下，评估引擎查找工具时先到该目录寻址

## 工具寻址规则

所有评估依赖的外部工具统一存放于 `.opencode/evaluation/sql2java/tools/`，评估引擎查找工具时优先到该目录寻址，不再分散到其他子目录。

```text
.opencode/evaluation/sql2java/
├── tools/                            ← 可执行工具 (jar / Maven / 启动脚本)
│   ├── apache-maven-3.9.16/          ← Maven 发行版 (L2/L4 使用)
│   │   ├── bin/mvn, mvn.cmd          ← 跨平台启动器
│   │   ├── boot/, conf/, lib/        ← Maven 核心文件
│   ├── checkstyle-10.12.5-all.jar    ← Checkstyle CLI (L2 使用，独立运行，不依赖 Maven)
│   ├── sql2java-mvn                  ← 跨平台 Maven 启动脚本 (bash，Linux/麒麟/Mac)
│   └── sql2java-mvn.cmd             ← 跨平台 Maven 启动脚本 (cmd，Windows)
├── quality-rules/                    ← 规约规则定义 (只读配置，不放可执行文件)
│   ├── checkstyle.xml                ← Checkstyle 规约规则 (含 Java 8 合规检查)
│   └── README.md                     ← 规则来源与说明
├── equivalence-cases/                ← L4 行为等价测试用例
├── measurement-cases/                ← L3 语义分析度量用例
└── baselines/                        ← 评估报告输出目录
```

### 工具调用约定

- **Maven**: `tools/sql2java-mvn` (bash) / `tools\sql2java-mvn.cmd` (Windows) — 自动检测 OS/Arch/JAVA_HOME，使用隔离本地仓库
- **Maven (直接)**: `tools/apache-maven-3.9.16/bin/mvn` 或 `mvn.cmd` — 需手动设置 JAVA_HOME
- **Checkstyle**: `java -jar tools/checkstyle-10.12.5-all.jar -c quality-rules/checkstyle.xml` — 独立运行，零侵入，不依赖 Maven

**路径变量约定**：

```bash
TOOLS_DIR=".opencode/evaluation/sql2java/tools"
# Maven (跨平台脚本)
MVN_CMD="${TOOLS_DIR}/sql2java-mvn"        # bash (Linux/麒麟/Mac)
MVN_CMD="${TOOLS_DIR}\sql2java-mvn.cmd"    # cmd  (Windows)
# Maven (直接调用)
MVN_DIR="${TOOLS_DIR}/apache-maven-3.9.16"
# Checkstyle
CHECKSTYLE_JAR="${TOOLS_DIR}/checkstyle-10.12.5-all.jar"
CHECKSTYLE_RULES=".opencode/evaluation/sql2java/quality-rules/checkstyle.xml"
```

## 参数解析

解析 `$ARGUMENTS`：

### 语法

```
/sql2java_evaluation [选项]
```

所有参数均可选，默认从最近一次 `/sql2java` 运行的 artifacts 中自动推导。

| 参数 | 必填 | 说明 | 不传时的自动推导 |
|------|------|------|-----------------|
| `--source <sql-dir>` | 否 | PL/SQL 源码目录 | 从 `inventory-index.json` 的 `sourcePath` 字段读取 |
| `--output <java-project-dir>` | 否 | `/sql2java` 生成的 Java 项目目录 | 从 `scaffold.json` 的 `projectRoot` 字段读取 |
| `--run-id <id>` | 否 | 工作流 runId | 取 `.workflow-artifacts/` 下最新的 `run-*` 目录 |
| `--layers <list>` | 否 | 逗号分隔要执行的层级（默认 `l1,l2,l3,l4`） | — |
| `--resume` | 否 | 从上次中断处继续评估（检查 reportDir 中已有的 JSON 跳过已完成层） | — |
| `--status` | 否 | 查看当前评估状态（各层完成情况、耗时、得分） | — |

### 参数自动推导流程

```
/sql2java_evaluation（无参数）
  │
  ├─ Step 1: 定位 runId
  │   ls -td .workflow-artifacts/run-* | head -1
  │   → .workflow-artifacts/run-20260612-143022/
  │
  ├─ Step 2: 推导 sourceDir（--source）
  │   读取 .workflow-artifacts/{runId}/inventory-index.json
  │   提取 .sourcePath → "resources/mfg_erp_sql_tiny"
  │
  ├─ Step 3: 推导 outputDir（--output）
  │   读取 .workflow-artifacts/{runId}/scaffold.json
  │   提取 .projectRoot → "generated/mfg-erp-sql"
  │
  └─ Step 4: 创建 reportDir（以 runId 命名，方便与 artifacts 对应）
      .opencode/evaluation/sql2java/baselines/{runId}/
```

**推导失败时的错误提示**：

| 失败点 | 错误信息 |
|--------|---------|
| 找不到 run-* 目录 | "未找到工作流 artifacts，请先运行 /sql2java" |
| inventory-index.json 不存在 | "未找到 inventory-index.json，工作流可能未完成 inventory 阶段" |
| scaffold.json 不存在 | "未找到 scaffold.json，工作流可能未完成 scaffold 阶段。请通过 --output 手动指定" |
| sourcePath 目录不存在 | "inventory-index.json 中的 sourcePath 不存在: {path}" |
| projectRoot 目录不存在 | "scaffold.json 中的 projectRoot 不存在: {path}，请通过 --output 手动指定" |

### 参数提取顺序

1. 推导 `runId`（参数或自动）
2. 从 artifacts 推导 `sourceDir` 和 `outputDir`
3. 如果命令行提供了 `--source` / `--output`，覆盖推导值
4. 从 `$ARGUMENTS` 提取 `--layers <list>` → `layers`（默认 `l1,l2,l3,l4`）

### 评估报告输出目录（自动推导）

评估报告以 `runId` 命名，与 `.workflow-artifacts/{runId}/` 一一对应：

```text
.opencode/evaluation/sql2java/baselines/
├── run-20260612-143022/     ← 对应 .workflow-artifacts/run-20260612-143022/
│   ├── eval-report.json
│   ├── eval-report.md
│   ├── l1-metrics.json
│   ├── l2-summary.json
│   ├── l3-summary.json
│   ├── l4-summary.json
│   └── l4-target/           ← L4 中间产物溯源（surefire 报告、编译的测试类、测试源文件）
│       ├── surefire-reports/
│       ├── L4EquivalencePureJavaTest.java
│       ├── L4EquivalenceH2Test.java
│       └── L4Equivalence*.class
└── run-20260620-091530/     ← 对应 .workflow-artifacts/run-20260620-091530/
    └── ...
```

```bash
# 自动创建（直接用 runId 命名）
REPORT_DIR=".opencode/evaluation/sql2java/baselines/${RUN_ID}"
mkdir -p "$REPORT_DIR"
```

### 路由规则

1. `--status` → 查看当前评估状态，输出各层完成情况，结束
2. `--resume` → 检查 reportDir 中已有的 JSON 文件，跳过已完成层，从中断处继续执行
3. 无参数/部分参数 → 自动推导 runId + sourceDir + outputDir → 从头执行评估
4. 推导失败（无 artifacts） → 报错提示先运行 `/sql2java`

---

## --status: 查看评估状态

读取 `{reportDir}/` 下已有的文件，展示各层完成情况和得分。

### 执行步骤

1. 推导 `runId` 和 `reportDir`（与正常流程相同）
2. 检查 reportDir 是否存在：不存在则提示 "该 runId 尚未开始评估，直接运行 /sql2java_evaluation 即可"
3. 逐层检查 JSON 文件并读取得分

### 输出格式

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 评估状态: run-20260612-143022
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ReportDir: .opencode/evaluation/sql2java/baselines/run-20260612-143022/
  执行模式: L1串行 → L2+L3并行 → L4串行 → 汇总

  L1 转译效率度量      ✅ 完成    firstPassRate: 100% | 耗时: 8m | Tokens: 308K
  L2 代码质量度量      ✅ 完成    总分: 92.3 (A)
  L3 语义分析度量      ⏳ 中断    已完成: sqlCoverage + tableCoverage
  L4 行为等价度量      ⬚ 未开始

  综合评分: — (评估未完成)

  提示: 运行 /sql2java_evaluation --resume 从中断处继续
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 各层状态判定

| 文件 | 状态 |
|------|------|
| `l1-metrics.json` 存在且非空 | ✅ 完成 |
| `l2-summary.json` 存在且含 scores.total | ✅ 完成 |
| `l3-summary.json` 存在且含 scores.total | ✅ 完成；部分字段缺失时标记 ⏳ 中断 |
| `l4-summary.json` 存在且含 scores.equivalenceRate | ✅ 完成；部分用例未执行时标记 ⏳ 中断 |
| 文件不存在 | ⬚ 未开始 |

---

## --resume: 从中断处继续

### 执行步骤

1. 推导 `runId`、`sourceDir`、`outputDir`、`reportDir`（与正常流程相同）
2. 检查 reportDir 是否存在：不存在则报错 "未找到中断的评估，请直接运行 /sql2java_evaluation"
3. 逐层检查已完成的 JSON 文件，构建跳过列表：

```bash
# 检查各层完成状态
test -f "$REPORT_DIR/l1-metrics.json"   && SKIP_L1=true
test -f "$REPORT_DIR/l2-summary.json"   && SKIP_L2=true
test -f "$REPORT_DIR/l3-summary.json"   && SKIP_L3=true
test -f "$REPORT_DIR/l4-summary.json"   && SKIP_L4=true
```

4. 输出跳过信息：

```
📊 恢复评估: run-20260612-143022
  ⏭ L1 转译效率度量      跳过 (已完成)
  ⏭ L2 代码质量度量      跳过 (已完成)
  ▶ L3 语义分析度量      继续执行...
  ⬚ L4 行为等价度量      待执行
```

5. 按编排策略执行未完成的层级：
   - L2 和 L3 都未完成 → 并行启动两个 Subagent（见"执行编排策略"段落）
   - 仅 L2 未完成 → 启动 Subagent-L2
   - 仅 L3 未完成 → 启动 Subagent-L3
   - L2+L3 完成后执行 L4（串行）
6. 全部完成后，生成/更新 `eval-report.json` + `eval-report.md`

### L2 中断恢复（长时间操作）

L2 包含 Checkstyle CLI 扫描等耗时操作。如果 L2 执行到一半中断：

- `l2-summary.json` 不存在 → 整个 L2 重新执行
- `l2-checkstyle.log` 存在但 `l2-summary.json` 不存在 → Checkstyle 已完成，但后续步骤需重做（agent 可复用已有 log 避免重复解析）

### L4 中断恢复（逐用例执行）

L4 逐用例执行，如果中途断开：
- 检查 `l4-summary.json` 是否存在
- 如存在且 `caseResults` 数组非空 → 已执行的用例跳过，从下一个用例继续
- 如不存在 → 整个 L4 从头执行
- 最终合并已跳过用例和新执行用例的结果，重新计算 equivalenceRate

### resume 恢复检查项

- [ ] `--resume` 时正确识别已完成的层（基于 JSON 文件存在性）
- [ ] 跳过已完成的层，不重复执行
- [ ] L4 恢复时正确合并已有 caseResults 和新执行结果
- [ ] 全部完成后 eval-report 包含所有四层的完整数据

---

## 自动推导规则

### sourceDir 和 outputDir 校验

自动推导后，校验目录是否存在：

```bash
# sourceDir 校验（从 inventory-index.json 推导）
test -d "{sourceDir}" || echo "❌ inventory-index.json 中的 sourcePath 不存在: {sourceDir}"

# outputDir 校验（从 scaffold.json 推导）
test -f "{outputDir}/pom.xml" || echo "❌ scaffold.json 中的 projectRoot 不是有效 Java 项目: {outputDir}"
```

### runId 推导

如果未提供 `--run-id`：
```bash
ls -td .workflow-artifacts/run-* 2>/dev/null | head -1
```
如果找不到，报错 "未找到工作流 artifacts，请先运行 /sql2java"。

### 数据集级别推导

根据 `sourceDir` 路径自动判断：
- 包含 `tiny` → `datasetLevel = "tiny"`
- 包含 `mini` → `datasetLevel = "mini"`
- 其他 → `datasetLevel = "full"`

---

## 工作流程

```
参数解析 → 推导 runId → 自动创建 reportDir
  │
  ├─ Step 1: L1 转译效率度量（串行，~5秒）
  │   读取 run-metrics.json → 提取效率指标 → 写 {reportDir}/l1-metrics.json
  │
  ├─ Step 2: L2+L3 并行执行（两个 Subagent 同时运行）
  │   ├─ Subagent-L2: grep + checkstyle CLI → 写 {reportDir}/l2-summary.json
  │   └─ Subagent-L3: grep 比对 PL/SQL ↔ Java 结构 → 写 {reportDir}/l3-summary.json
  │
  ├─ Step 3: L4 行为等价度量（串行，L2+L3 完成后执行）
  │   读取 equivalence-cases/*.yaml → sql2java-mvn 测试 → 写 {reportDir}/l4-summary.json
  │
  └─ Step 4: 汇总（串行）
     读取 l1~l4 JSON → 计算综合评分 → 写 {reportDir}/eval-report.json + eval-report.md
```

### 变量约定

| 变量 | 来源 | 含义 |
|------|------|------|
| `sourceDir` | `--source` 参数或自动推导 | PL/SQL 源码目录 |
| `outputDir` | `--output` 参数或自动推导 | `/sql2java` 生成的 Java 项目目录（含 pom.xml） |
| `reportDir` | 自动推导 | 评估报告输出目录：`.opencode/evaluation/sql2java/baselines/{runId}/` |
| `runId` | `--run-id` 或自动推导 | 工作流 run ID |

---

## 执行编排策略

L1/L2/L3/L4 四层评估彼此零依赖（各自独立读取 workflow artifacts + 生成项目），仅汇总报告依赖全部四层输出。为提高运行效率，L2 和 L3 可并行执行。

### 并行执行顺序

```
Step 1: L1（主 Agent 串行执行，~5秒）
Step 2: L2 + L3（两个 Subagent 并行执行）
Step 3: L4（主 Agent 串行执行，等 L2+L3 完成后开始）
Step 4: 汇总报告（主 Agent 串行执行）
```

### 并行 Subagent 启动方式

L1 完成后，主 Agent 使用 `Agent` 工具同时启动两个 Subagent 处理 L2 和 L3。每个 Subagent 的 prompt 必须是**自完备的** — 包含完整的执行指令，不引用"下方段落"（Subagent 无法看到主 Agent 上下文中的其他段落）。

**Subagent-L2 prompt**（主 Agent 将变量替换为实际值后直接传入）：

```text
你是 SQL2Java 评估引擎的 L2 代码质量度量子任务。你只负责 L2，不执行 L1、L3、L4 或汇总。

变量：
- sourceDir = {sourceDir 的实际值}
- outputDir = {outputDir 的实际值}
- reportDir = {reportDir 的实际值}

工具寻址：
- Checkstyle CLI: java -jar .opencode/evaluation/sql2java/tools/checkstyle-10.12.5-all.jar -c .opencode/evaluation/sql2java/quality-rules/checkstyle.xml
- 所有外部工具统一存放在 .opencode/evaluation/sql2java/tools/ 目录下

执行步骤：

1. 代码行数统计：
   - PL/SQL 行数：find {sourceDir} -name "*.sql" -o -name "*.pks" -o -name "*.pkb" | xargs cat | wc -l → details.sqlLoc
   - Java 行数：find {outputDir}/src -name "*.java" | xargs cat | wc -l → details.javaLoc
   - Java 文件数：find {outputDir}/src -name "*.java" | wc -l → details.javaFileCount
   - locRatio = javaLoc / sqlLoc

2. TODO 残留扫描：
   - grep -rn "TODO: \[translate\]" {outputDir}/src --include="*.java" | wc -l → todoTranslate
   - grep -rn "TODO: \[test\]" {outputDir}/src --include="*.java" | wc -l → todoTest
   - grep -rn "// TODO" {outputDir}/src --include="*.java" | wc -l → todoAll
   - todoOther = todoAll - todoTranslate - todoTest
   - score.todo = max(0, (1 - todoTranslate / javaFileCount) * 100)

3. Checkstyle 规约检查（含 Java 8 合规）：
   java -jar .opencode/evaluation/sql2java/tools/checkstyle-10.12.5-all.jar \
     -c .opencode/evaluation/sql2java/quality-rules/checkstyle.xml \
     {outputDir}/src/main/java
   写入 {reportDir}/l2-checkstyle.log
   统计违规总数 → details.checkstyleViolations
   按类别分类：ByName / ByFormat / ByOop / ByException / java8Violations / ByMethodComplexity
   分类规则：
   - 包含 Name/name/命名 → ByName
   - 包含 Indent/Line/length/行宽/缩进 → ByFormat
   - 包含 Override/Final/BigDecimal → ByOop
   - 包含 Catch/Empty/空 catch → ByException
   - 包含 Java8/Java 9~15 → java8Violations
   - 包含 方法超过/圈复杂度/复杂度超过 → ByMethodComplexity
   score.style = max(0, (1 - checkstyleViolations / javaLoc) * 100)

4. 综合评分：
   L2 总分 = score.todo × 0.30 + score.style × 0.70
   评级：≥95→A+, ≥85→A, ≥70→B, ≥50→C, <50→D

5. 写入 {reportDir}/l2-summary.json（JSON 格式见原命令文件 L2 输出段落）

完成后仅输出：l2-summary.json 的 scores.total 值。不要执行其他层级。
```

**Subagent-L3 prompt**（主 Agent 将变量替换为实际值后直接传入）：

```text
你是 SQL2Java 评估引擎的 L3 语义分析度量子任务。你只负责 L3，不执行 L1、L2、L4 或汇总。

变量：
- sourceDir = {sourceDir 的实际值}
- outputDir = {outputDir 的实际值}
- reportDir = {reportDir 的实际值}
- runId = {runId 的实际值}
- artifactsDir = .workflow-artifacts/{runId 的实际值}

执行步骤：

1. SQL 语句覆盖率：
   - PL/SQL 统计：grep -rcn 各类型 SQL 语句 → plsqlSql (select/insert/update/delete/merge)
   - MyBatis XML 统计：grep -rc 各类型标签 → mybatisMappings (select/insert/update/delete)
   - score.sqlCoverage = min(100, round(mybatisMappings.total / plsqlSql.total * 100))

2. 表级覆盖率：
   - PL/SQL 表名：grep -rho "t_[a-z_]*" {sourceDir} --include="*.sql" | sort -u → plsqlTables
   - MyBatis 表名：grep -rho "t_[a-z_]*" {outputDir}/src/main/resources --include="*.xml" | sort -u → mybatisTables
   - uncoveredTables = plsqlTables - mybatisTables
   - score.tableCoverage = round((plsqlTables.length - uncoveredTables.length) / plsqlTables.length * 100)

3. 子程序映射覆盖率：
   - 从 {artifactsDir}/inventory-index.json 提取所有子程序名 → allSubprograms
   - 从 Java 源码提取方法名：grep -rhoP "(?:public|private|protected)\s+\w+\s+(\w+)\s*\(" {outputDir}/src/main/java --include="*.java"
   - snake_case → camelCase 近似匹配 → mappedCount
   - score.subprogramCoverage = round(mappedCount / totalCount * 100)

4. 异常映射匹配度：
   - grep -rcn "EXCEPTION\s\+WHEN" {sourceDir} → plsqlExceptions
   - grep -rcn "catch\s*(" {outputDir}/src/main/java → javaCatches
   - grep -rcn "RAISE_APPLICATION_ERROR" {sourceDir} → plsqlRaises
   - grep -rcn "throw new" {outputDir}/src/main/java → javaThrows
   - grep -rn "catch\s*\([^)]+\)\s*\{\s*\}" {outputDir}/src/main/java --include="*.java" | wc -l → emptyCatchCount（近似值，仅单行形式）
   - effectiveCatchCount = javaCatches - emptyCatchCount
   - ratio = effectiveCatchCount / plsqlExceptions（空catch不算有效映射）
   - score.exceptionMapping = max(0, round((1 - |ratio - 1|) * 100))

5. 控制流结构匹配：
   - PL/SQL：grep IF/LOOP/RETURN → plsqlCF
   - Java：grep if/for/while/return → javaCF
   - 计算余弦相似度 → score.controlFlow

6. 测量用例（动态扫描）：
   - find .opencode/evaluation/sql2java/measurement-cases -name "*.yaml" -type f | sort
   - 逐用例比对 actual_plsql vs expected / actual_java vs expected
   - 追加到 l3-summary.json 的 details.measurementCases 数组

7. 综合评分：
   L3 总分 = score.sqlCoverage × 0.25 + score.tableCoverage × 0.25 + score.subprogramCoverage × 0.25 + score.exceptionMapping × 0.125 + score.controlFlow × 0.125

8. 写入 {reportDir}/l3-summary.json（JSON 格式见原命令文件 L3 输出段落）

完成后仅输出：l3-summary.json 的 scores.total 值。不要执行其他层级。
```

### --resume 时的编排策略

`--resume` 检查已完成的 JSON 文件，跳过已完成层，对未完成的 L2+L3 优先并行启动：

| 已完成状态 | 编排行为 |
| --- | --- |
| L2/L3 都已完成 | 直接进入 L4 |
| L2/L3 都未完成 | 并行启动两个 Subagent |
| 仅 L2 已完成 | 只启动 Subagent-L3 |
| 仅 L3 已完成 | 只启动 Subagent-L2 |

### --layers 时的编排策略

`--layers` 参数指定要执行的层级，编排引擎根据指定层级决定是否并行：

| --layers 值 | 编排行为 |
| --- | --- |
| `l1,l2,l3,l4`（默认） | L1 串行 → L2+L3 并行 → L4 串行 → 汇总 |
| `l1,l2` | 只执行 L1 + L2（串行） |
| `l2,l3` | L2+L3 并行（跳过 L1） |
| `l1,l3` | 只执行 L1 + L3（串行） |
| `l4` | 只执行 L4（串行） |
| 任意含 `l2,l3` 的组合 | L2+L3 并行 |

无论指定哪些层，汇总报告始终执行（读取已有的 JSON）。

### 安全边界

- L2 和 L3 只读取 `src/main/` 目录（不写入项目文件），并行执行无冲突
- L4 会注入文件到 `src/test/resources/` + 在 `target/` 下产生编译产物，必须在 L2+L3 完成后单独执行
- L4 完成后必须清理 `outputDir`：注入的配置文件直接删除；`target/` 下的中间产物移动到 `{reportDir}/l4-target/` 保留溯源后从 `outputDir` 中删除
- 每个 Subagent 写入独立的 reportDir 文件（l2-summary.json vs l3-summary.json），无文件名冲突

## L1: 转译效率度量

### 数据来源

L1 数据由 `/sql2java` 工作流在执行过程中**自动采集**，无需手动传入。

```
/sql2java resources/mfg_erp_sql_tiny
  │
  ▼  工作流引擎自动执行
.workflow-artifacts/run-20260612-143022/
├── metrics/
│   ├── run-metrics.json      ← PhaseMetricsCollector 自动生成
│   ├── inventory.json        ← 各阶段的 token/cost/耗时/工具调用
│   ├── analyze.json
│   ├── translate.json
│   ├── review.json
│   ├── verify.json
│   └── fix-1.json            ← fix 阶段（可能多轮）
├── inventory-index.json
├── translations/
└── run.json
```

`/sql2java_evaluation` 通过 `runId` 找到该目录：

```
/sql2java_evaluation --source ... --output ...
  │
  ├─ 有 --run-id 参数 → 直接定位 .workflow-artifacts/{runId}/metrics/run-metrics.json
  │
  └─ 无 --run-id 参数 → 自动查找最新的 run：
     ls -td .workflow-artifacts/run-* | head -1
     → .workflow-artifacts/run-20260612-143022/
```

**如果找不到**：报错 "未找到工作流 artifacts，请先运行 /sql2java"。

### 输入

| 数据源 | 路径 | 说明 |
|--------|------|------|
| run-metrics.json | `.workflow-artifacts/{runId}/metrics/run-metrics.json` | PhaseMetricsCollector 已自动生成 |

### 执行步骤

1. **读取** `run-metrics.json`（bash `cat` + 解析 JSON）

2. **提取摘要组** `summary`：

```
firstPassRate      ← .business.reviewPassedRate
fixCycles          ← .business.fixCyclesCount
fixCostRatio       ← sum(phases[phase="fix"].totalCost) / totalCost（totalCost>0 时计算，否则 0）
totalDurationMs    ← .totalWallDurationMs
totalApiCalls      ← .totalApiCallCount
totalToolCalls     ← .totalToolCallCount
```

3. **提取 token 使用量** `tokens` — 确定性数据，始终有值：

```
input / output / cacheRead / cacheWrite / reasoning ← .totalTokens 各字段
total ← input + output + cacheRead + cacheWrite + reasoning
```

4. **条件提取费用组** `cost` — 仅 `totalCost > 0` 时写入：

```
totalCost          ← .totalCost（>0 才写入 cost 组，0 或 null 时整组省略）
costPerSubprogram  ← totalCost / oracleProcedures（oracleProcedures>0 时才写入）
```

5. **提取吞吐量组** `throughput`：

```
oracleProcedures      ← .business.oracleProcedureCount
throughputPerHour     ← oracleProcedures / (totalDurationMs / 3600000)（totalDurationMs>0 且 oracleProcedures>0 时）
durationPerPhase      ← 遍历 .phases 数组，提取 { phase名: wallDurationMs }
```

6. **提取产出组** `output`：

```
oraclePackages        ← .business.oraclePackageCount
oracleProcedures      ← .business.oracleProcedureCount
javaFiles             ← .business.javaFileCount
testFiles             ← .business.testFileCount
todosRemaining        ← .business.totalTodosRemaining
compilationSuccess    ← .business.compilationSuccess
reviewAverageScore    ← .business.reviewAverageScore
```

7. **提取逐阶段明细** `phaseBreakdown`：

```
遍历 .phases 数组，每阶段提取:
  { phase, durationMs ← wallDurationMs, apiCalls ← apiCallCount, tokens: { input, output } }
```

8. **组装并写入** `{reportDir}/l1-metrics.json`（cost 组为空时不写入该字段）

### 输出

写入 `{reportDir}/l1-metrics.json`。

采用**分组结构**替代原扁平结构：确定性数据（tokens、耗时、产出）分组优先展示，费用组仅在数据可用时写入（`totalCost > 0`），否则整组省略。

```json
{
  "runId": "run-20260612-143022",
  "status": "completed",
  "datasetLevel": "tiny",

  "summary": {
    "firstPassRate": 100,
    "fixCycles": 0,
    "fixCostRatio": 0.0,
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
      "inventory": 12000,
      "analyze": 45000,
      "plan": 35000,
      "scaffold": 28000,
      "translate": 180000,
      "dedup": 60000,
      "review": 75000,
      "verify": 40000
    }
  },

  "output": {
    "oraclePackages": 2,
    "oracleProcedures": 15,
    "javaFiles": 18,
    "testFiles": 4,
    "todosRemaining": 1,
    "compilationSuccess": true,
    "reviewAverageScore": 88
  },

  "phaseBreakdown": [
    { "phase": "inventory",  "durationMs": 12000, "apiCalls": 5,  "tokens": { "input": 12000, "output": 3000 } },
    { "phase": "analyze",    "durationMs": 45000, "apiCalls": 8,  "tokens": { "input": 35000, "output": 8000 } },
    { "phase": "plan",       "durationMs": 35000, "apiCalls": 6,  "tokens": { "input": 28000, "output": 5000 } },
    { "phase": "scaffold",   "durationMs": 28000, "apiCalls": 7,  "tokens": { "input": 22000, "output": 4000 } },
    { "phase": "translate",  "durationMs": 180000,"apiCalls": 12, "tokens": { "input": 85000, "output": 6000 } },
    { "phase": "dedup",      "durationMs": 60000, "apiCalls": 3,  "tokens": { "input": 8000, "output": 2000 } },
    { "phase": "review",     "durationMs": 75000, "apiCalls": 6,  "tokens": { "input": 20000, "output": 4000 } },
    { "phase": "verify",     "durationMs": 40000, "apiCalls": 3,  "tokens": { "input": 3000, "output": 2000 } }
  ]
}
```

#### 条件省略规则

| 分组 | 省略条件 | 说明 |
|------|---------|------|
| `cost` | `totalCost === 0` 或 `totalCost === null` | 很多模型不提供费用数据，0 值或 null 时整个 cost 组不写入 JSON |
| `cost.costPerSubprogram` | `oracleProcedures === 0` | 除零保护，不写 null |
| `throughput.throughputPerHour` | `totalDurationMs === 0` 或 `oracleProcedures === 0` | 除零保护 |
| `tokens` | 永不省略 | token 数据始终有值（PhaseMetricsCollector 确定性采集） |
| `phaseBreakdown` | 永不省略 | phases 数组始终存在 |

### 指标健康基准

| 指标 | 健康 | 告警 | 说明 |
|------|------|------|------|
| firstPassRate | >80% | <50% | review 首轮通过率，低于说明 translator prompt 需优化 |
| throughputPerHour | >40 | <20 | 每小时翻译子程序数，低于说明响应慢或工具调用过多 |
| fixCycles | 0~1 | >3 | fix 循环次数，过多说明翻译质量差 |
| fixCostRatio | <15% | >30% | fix 成本占总成本比例（仅费用可用时评估） |
| costPerSubprogram | $0.03~$0.10 | >$0.20 | 单子程序费用（仅费用可用时评估） |

---

## L2: 代码质量度量

### 输入

| 数据源 | 路径 | 说明 |
|--------|------|------|
| Java 源码 | `{outputDir}/src/main/java/**/*.java` | 被测 Java 代码 |
| MyBatis XML | `{outputDir}/src/main/resources/**/*.xml` | Mapper XML |
| PL/SQL 源码 | `{sourceDir}/**/*.sql` | 原始 SQL（统计行数用） |
| Checkstyle 规则 | `.opencode/evaluation/sql2java/quality-rules/checkstyle.xml` | 代码规约 + Java 8 合规规则定义 |
| Checkstyle CLI | `.opencode/evaluation/sql2java/tools/checkstyle-10.12.5-all.jar` | 独立运行工具（不依赖 Maven） |

### 执行步骤

按顺序执行 3 项检查，每项失败不阻断后续：

#### Step 1: 代码行数统计

```bash
# PL/SQL 行数
find {sourceDir} -name "*.sql" -o -name "*.pks" -o -name "*.pkb" | xargs cat | wc -l

# Java 行数
find {outputDir}/src -name "*.java" | xargs cat | wc -l

# Java 文件数
find {outputDir}/src -name "*.java" | wc -l
```

- `details.sqlLoc` = PL/SQL 总行数
- `details.javaLoc` = Java 总行数
- `details.locRatio` = javaLoc / sqlLoc（健康范围 2.5~4.0）
- `details.javaFileCount` = Java 文件总数

#### Step 2: TODO 残留扫描

```bash
# 按类型分类统计
grep -rn "TODO: \[translate\]" {outputDir}/src --include="*.java" | wc -l   → todoTranslate
grep -rn "TODO: \[test\]"      {outputDir}/src --include="*.java" | wc -l   → todoTest
grep -rn "// TODO"             {outputDir}/src --include="*.java" | wc -l   → todoAll
todoOther = todoAll - todoTranslate - todoTest
```

`score.todo = max(0, (1 - todoTranslate / javaFileCount) * 100)`

#### Step 3: Checkstyle 规约检查（含 Java 8 合规）

规约规则文件 `.opencode/evaluation/sql2java/quality-rules/checkstyle.xml` 同时包含代码风格规约和 Java 8 合规检查（10 条禁止项）。使用预置的 Checkstyle CLI 独立运行，不依赖 Maven 或 pom.xml 配置。

```bash
java -jar .opencode/evaluation/sql2java/tools/checkstyle-10.12.5-all.jar \
  -c .opencode/evaluation/sql2java/quality-rules/checkstyle.xml \
  {outputDir}/src/main/java
```

将完整输出写入 `{reportDir}/l2-checkstyle.log`

统计输出中的违规总数 → `details.checkstyleViolations`

按类别分类（近似统计，依据 Checkstyle 输出消息内容）：
- 包含 `Name` / `name` / `命名` → `checkstyleByName`（命名类）
- 包含 `Indent` / `Line` / `length` / `行宽` / `缩进` → `checkstyleByFormat`（格式类）
- 包含 `Override` / `Final` / `BigDecimal` → `checkstyleByOop`（OOP 类）
- 包含 `Catch` / `Empty` / `空 catch` → `checkstyleByException`（异常类）
- 包含 `Java8` / `Java 9` / `Java 10` / `Java 11` / `Java 12` / `Java 13` / `Java 14` / `Java 15` → `java8Violations`（Java 8 合规类）
- 包含 `方法超过` / `圈复杂度` / `复杂度超过` → `checkstyleByMethodComplexity`（方法质量类）

`score.style = max(0, (1 - checkstyleViolations / javaLoc) * 100)`

### 综合评分

```
L2 总分 = score.todo     × 0.30
        + score.style    × 0.70
```

评级：≥95 → A+，≥85 → A，≥70 → B，≥50 → C，<50 → D

### 输出

写入 `{reportDir}/l2-summary.json`：

```json
{
  "scores": {
    "todo": 93,
    "style": 97,
    "total": 95.8
  },
  "grade": "A",
  "details": {
    "sqlLoc": 412,
    "javaLoc": 1280,
    "locRatio": 3.11,
    "javaFileCount": 18,
    "todoTranslate": 1,
    "todoTest": 0,
    "todoOther": 2,
    "checkstyleViolations": 4,
    "checkstyleByName": 1,
    "checkstyleByFormat": 2,
    "checkstyleByOop": 0,
    "checkstyleByException": 1,
    "java8Violations": 0,
    "checkstyleByMethodComplexity": 0
  }
}
```

---

## L3: 语义分析度量

### 输入

| 数据源 | 路径 | 说明 |
|--------|------|------|
| PL/SQL 源码 | `{sourceDir}/**/*.sql` | 提取 SQL 语句/表名/控制流 |
| Java 源码 | `{outputDir}/src/main/java/**/*.java` | 提取控制流/异常处理 |
| MyBatis XML | `{outputDir}/src/main/resources/**/*.xml` | 提取 SQL 映射/表名 |
| inventory-index | `.workflow-artifacts/{runId}/inventory-index.json` | 子程序清单 |
| 类型映射表 | `.opencode/workflow/type-mappings.ts` | Oracle→Java 标准映射 |

### 执行步骤

#### Step 1: SQL 语句覆盖率

统计 PL/SQL 中各类型 SQL 语句数（`grep` 正则匹配）：

```bash
grep -rcn "^\s*SELECT\b"       {sourceDir} → plsqlSql.select
grep -rcn "^\s*INSERT\s+INTO"  {sourceDir} → plsqlSql.insert
grep -rcn "^\s*UPDATE\b"       {sourceDir} → plsqlSql.update
grep -rcn "^\s*DELETE\b"       {sourceDir} → plsqlSql.delete
grep -rcn "^\s*MERGE\b"        {sourceDir} → plsqlSql.merge
```

统计 MyBatis XML 中各类型映射数：

```bash
grep -rc "<select"  {outputDir}/src/main/resources --include="*.xml" → mybatisMappings.select
grep -rc "<insert"  {outputDir}/src/main/resources --include="*.xml" → mybatisMappings.insert
grep -rc "<update"  {outputDir}/src/main/resources --include="*.xml" → mybatisMappings.update
grep -rc "<delete"  {outputDir}/src/main/resources --include="*.xml" → mybatisMappings.delete
```

`score.sqlCoverage = min(100, round(mybatisMappings.total / plsqlSql.total * 100))`

#### Step 2: 表级覆盖率

从 PL/SQL 提取引用的表名（`t_` 前缀）：

```bash
grep -rho "t_[a-z_]*" {sourceDir} --include="*.sql" | sort -u → plsqlTables
```

从 MyBatis XML 提取引用的表名：

```bash
grep -rho "t_[a-z_]*" {outputDir}/src/main/resources --include="*.xml" | sort -u → mybatisTables
```

`uncoveredTables = plsqlTables - mybatisTables`
`score.tableCoverage = round((plsqlTables.length - uncoveredTables.length) / plsqlTables.length * 100)`

#### Step 3: 子程序映射覆盖率

从 `inventory-index.json` 提取所有子程序名 → `allSubprograms`

从 Java 源码提取所有方法名：

```bash
grep -rhoP "(?:public|private|protected)\s+\w+\s+(\w+)\s*\(" {outputDir}/src/main/java --include="*.java"
```

对每个子程序名做 snake_case → camelCase 近似匹配：
- `receive_stock` → 查找 Java 方法名是否包含 `receiveStock`
- `get_item` → 查找 `getItem`

`score.subprogramCoverage = round(mappedCount / totalCount * 100)`

#### Step 4: 异常映射匹配度

```bash
grep -rcn "EXCEPTION\s\+WHEN"      {sourceDir} → plsqlExceptions
grep -rcn "catch\s*("              {outputDir}/src/main/java → javaCatches
grep -rcn "RAISE_APPLICATION_ERROR" {sourceDir} → plsqlRaises
grep -rcn "throw new"              {outputDir}/src/main/java → javaThrows
grep -rn "catch\s*\([^)]+\)\s*\{\s*\}" {outputDir}/src/main/java --include="*.java" | wc -l → emptyCatchCount（近似值，仅单行形式）
```

`effectiveCatchCount = javaCatches - emptyCatchCount`（空catch不算有效映射）
`ratio = effectiveCatchCount / plsqlExceptions`
`score.exceptionMapping = max(0, round((1 - |ratio - 1|) * 100))`（比率越接近 1.0 越好）

#### Step 5: 控制流结构匹配

```bash
# PL/SQL 控制流
grep -rcn "^\s*IF\b"                    {sourceDir} → plsqlCF.if
grep -rcn "^\s*\(FOR\|WHILE\|LOOP\)\b"  {sourceDir} → plsqlCF.loop
grep -rcn "^\s*RETURN\b"                {sourceDir} → plsqlCF.return

# Java 控制流
grep -rcn "^\s*if\s*("                  {outputDir}/src/main/java → javaCF.if
grep -rcn "^\s*\(for\|while\)\s*("      {outputDir}/src/main/java → javaCF.loop
grep -rcn "^\s*return\b"                {outputDir}/src/main/java → javaCF.return
```

计算余弦相似度：`cosineSimilarity(plsqlCF, javaCF)` → `score.controlFlow`

### L3 测量用例

L3 的每个测量用例定义一个子程序的**预期结构特征**，评估时与实际翻译产出对比。
用例文件位于 `.opencode/evaluation/sql2java/measurement-cases/`。

每个用例包含：
- **SQL 语句预期**：该子程序包含多少条各类型 SQL
- **表引用预期**：该子程序引用了哪些表
- **控制流预期**：if/loop/return/exception 各有多少
- **异常映射预期**：EXCEPTION WHEN 应映射为哪些 Java 异常
- **类型映射预期**：参数/返回值的 Oracle→Java 类型映射

#### 用例发现（动态扫描，不依赖硬编码列表）

用例文件可能随时增减，**不维护硬编码列表**。评估时动态扫描目录：

```bash
# 扫描 measurement-cases 目录下所有 YAML 文件
find .opencode/evaluation/sql2java/measurement-cases -name "*.yaml" -type f | sort
```

对每个发现的 YAML 文件：

1. 读取 YAML 内容，提取 `subprogram`、`source_file`、`expected` 字段
2. 按"测量用例的使用方式"段落中描述的步骤执行比对
3. 将比对结果追加到 `l3-summary.json` 的 `details.measurementCases` 数组

**YAML 文件命名约定**：`{package}_{subprogram}.yaml`，如 `core_pkg_get_item.yaml`、`fn_abc_class.yaml`。新增用例只需将 YAML 文件放入目录即可，无需修改本命令。

#### 用例文件格式

```yaml
# .opencode/evaluation/sql2java/measurement-cases/fn_abc_class.yaml
subprogram: fn_abc_class
source_file: resources/mfg_erp_sql_tiny/func/fn_abc_class.sql
description: DETERMINISTIC 独立函数，纯计算无 SQL

expected:
  sql_statements:
    select: 0
    insert: 0
    update: 0
    delete: 0
    merge: 0
  tables: []
  control_flow:
    if: 3       # IF p_cum_pct IS NULL / IF <= p_a_pct / ELSIF <= p_b_pct
    loop: 0
    return: 4   # RETURN NULL / RETURN 'A' / RETURN 'B' / RETURN 'C'
  exceptions: []
  type_mappings:
    - param: p_cum_pct
      oracle_type: NUMBER
      expected_java_type: BigDecimal
    - param: p_a_pct
      oracle_type: NUMBER
      expected_java_type: BigDecimal
    - param: p_b_pct
      oracle_type: NUMBER
      expected_java_type: BigDecimal
    - return: true
      oracle_type: VARCHAR2
      expected_java_type: String
```

```yaml
# .opencode/evaluation/sql2java/measurement-cases/core_pkg_get_item.yaml
subprogram: get_item
source_file: resources/mfg_erp_sql_tiny/pkg/core_pkg_body.sql
description: "%ROWTYPE 返回 + NO_DATA_FOUND 异常"

expected:
  sql_statements:
    select: 1   # SELECT * INTO v FROM t_item WHERE item_id = p_id
    insert: 0
    update: 0
    delete: 0
    merge: 0
  tables:
    - t_item
  control_flow:
    if: 0
    loop: 0
    return: 1
  exceptions:
    - plsql: "WHEN NO_DATA_FOUND"
      expected_java: "EmptyResultDataAccessException"
      severity: critical   # 必须映射
    - plsql: "RAISE_APPLICATION_ERROR(-20101, ...)"
      expected_java: "BizException"
      severity: critical
  type_mappings:
    - param: p_id
      oracle_type: NUMBER
      expected_java_type: Long
    - return: true
      oracle_type: "t_item%ROWTYPE"
      expected_java_type: ItemDO   # ROWTYPE → Entity 类
```

```yaml
# .opencode/evaluation/sql2java/measurement-cases/core_pkg_bulk_receive.yaml
subprogram: bulk_receive
source_file: resources/mfg_erp_sql_tiny/pkg/core_pkg_body.sql
description: "FORALL SAVE EXCEPTIONS + SQL%BULK_EXCEPTIONS + MERGE INTO"

expected:
  sql_statements:
    select: 0
    insert: 1   # FORALL INSERT INTO t_inventory_txn
    update: 0
    delete: 0
    merge: 1    # MERGE INTO t_item
  tables:
    - t_inventory_txn
    - t_item
  control_flow:
    if: 1       # IF SQLCODE = -24381
    loop: 2     # FOR i IN FIRST..LAST + FOR j IN 1..COUNT
    return: 0
  exceptions:
    - plsql: "WHEN OTHERS (SQLCODE=-24381)"
      expected_java: "catch (Exception e)"
      severity: critical   # FORALL 部分失败必须处理
      note: "不能简单 catch 后忽略，必须收集失败行"
  type_mappings:
    - param: p_lines
      oracle_type: "t_recv_tab (INDEX BY PLS_INTEGER)"
      expected_java_type: "List<RecvLineDTO>"
    - param: p_ok
      oracle_type: NUMBER
      expected_java_type: "int (OUT → 返回值或 DTO 字段)"
  special_constructs:
    - construct: "FORALL SAVE EXCEPTIONS"
      expected_java: "MyBatis batch executor + 单行异常收集"
      severity: critical
    - construct: "SQL%BULK_EXCEPTIONS"
      expected_java: "遍历 BatchUpdateException 的失败索引"
      severity: major
    - construct: "MERGE INTO"
      expected_java: "insertOrUpdate 或 先查后插/更新"
      severity: major
```

#### 测量用例的使用方式

评估时，agent 逐用例执行以下比对：

```
对每个 measurement-case:
  1. 从 source_file 中定位子程序的 PL/SQL 代码范围
  2. 统计该范围内的 SQL/表/控制流/异常 → 得到 actual_plsql
  3. 从 Java 产出中定位对应的翻译方法
  4. 统计 Java 方法的 SQL/表/控制流/异常 → 得到 actual_java
  5. 逐项对比 actual_plsql vs expected → 标记 pass/fail
  6. 逐项对比 actual_java vs expected → 标记 pass/fail
  7. 检查 special_constructs（如有）→ 标记 pass/fail
```

比对结果写入 `{reportDir}/l3-summary.json` 的 `details.measurementCases` 字段。

### 综合评分

```
L3 总分 = score.sqlCoverage        × 0.25
        + score.tableCoverage      × 0.25
        + score.subprogramCoverage × 0.25
        + score.exceptionMapping   × 0.125
        + score.controlFlow        × 0.125
```

### 输出

写入 `{reportDir}/l3-summary.json`：

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
    "plsqlTables": ["t_item", "t_error_log", "t_bom_header", "t_bom_line", "t_uom", "t_uom_conversion"],
    "mybatisTables": ["t_item", "t_error_log", "t_bom_header", "t_bom_line", "t_uom"],
    "uncoveredTables": ["t_uom_conversion"],
    "totalSubprograms": 15,
    "mappedSubprograms": 14,
    "unmappedSubprograms": ["archive_before"],
    "plsqlExceptions": 8,
    "javaCatches": 7,
    "plsqlRaises": 4,
    "javaThrows": 5,
    "emptyCatchCount": 1,
    "effectiveCatchCount": 6,
    "controlFlowVectors": {
      "plsql": { "if": 18, "loop": 4, "return": 8 },
      "java":  { "if": 20, "loop": 3, "return": 9 },
      "cosineSimilarity": 0.987
    }
  }
}
```

---

## L4: 行为等价度量

仅当 `--layers` 包含 `l4` 时执行。

### 三级降级策略

L4 支持三种执行模式，按数据库可用性自动降级：

```
┌────────────────────────────────────────────────────────────┐
│ 级别 1: pure_java — 纯 Java 测试（无需任何数据库）          │
│   db_level = "pure_java" 的用例                             │
│   → 直接调用 java_call，比对 expected_return / expected    │
│   → status = "passed" | "failed" | "error"                │
├────────────────────────────────────────────────────────────┤
│ 级别 2: h2_compatible — H2 内存库集成测试                   │
│   db_level = "h2_compatible" 的用例                         │
│   → 注入 H2 schema + setup.sql 初始化数据                  │
│   → 通过 Spring Boot Test 运行 java_call                   │
│   → 比对 expected 中的 return_fields / exception 等         │
│   → DB 状态断言（count_delta 等）通过 H2 查询验证          │
│   → status = "passed" | "failed" | "error"                │
├────────────────────────────────────────────────────────────┤
│ 级别 3: pg_only — 仅 PostgreSQL 可测                       │
│   db_level = "pg_only" 的用例                               │
│   → 有 PG: 执行 pg_call + java_call 比对                   │
│   → 无 PG: status = "skipped_pg_only"                      │
└────────────────────────────────────────────────────────────┘
```

**降级判定逻辑**：

1. 检测 PostgreSQL 可用性（尝试 `psql --version` 或 `pg_isready`）
2. 有 PG → 全部用例使用 pg_call + java_call 双端比对（原有逻辑不变）
3. 无 PG → 按每个用例的 `db_level` 字段选择降级执行策略

### 用例 db_level 分类

| db_level | 用例数 | 用例列表 | 说明 |
|----------|--------|---------|------|
| `pure_java` | 1 套 (8 cases) | `fn_abc_class` | setup.sql 为空，expected_return 为静态值 |
| `h2_compatible` | 11 套 (~33 cases) | `log_error, get_item, get_item_obj, create_item, get_bom_components, explode_bom, bom_cost, bulk_receive, issue_fifo, archive_before, list_bom` | H2 MODE=Oracle 可执行 setup.sql |
| `pg_only` | 1 套 (4 cases) | `trg_item_audit` | 触发器→AOP 需真实 DB 状态验证 |

### 输入

| 数据源 | 路径 | 说明 |
|--------|------|------|
| 测试用例 | `.opencode/evaluation/sql2java/equivalence-cases/*.yaml` | 行为等价测试定义（含 `db_level` 标注） |
| Java 项目 | `{outputDir}/src/` | 被测 Java 代码 |
| 源 SQL Schema | `{sourceDir}/../schema/tables.sql` + `sequences.sql` | Oracle 建表语句（运行时动态转换为 H2） |
| 数据库 | 可选 | PostgreSQL 实例（有则全量比对，无则降级到 H2） |

### 测试用例格式

```yaml
test_suite: fn_abc_class
description: ABC 分类函数行为等价验证
db_level: pure_java          # ← 新增字段: pure_java / h2_compatible / pg_only
source_file: resources/mfg_erp_sql_tiny/func/fn_abc_class.sql
java_class: com.erp.util.AbcClassUtil
java_method: classify

setup:
  sql: |
    -- 纯计算函数，无需数据初始化

cases:
  - name: A类_cumPct低于80%
    pg_call: "SELECT fn_abc_class(0.50)"
    java_call: "AbcClassUtil.classify(new BigDecimal(\"0.50\"))"
    expected_return: "A"

  - name: NULL输入返回NULL
    pg_call: "SELECT fn_abc_class(NULL)"
    java_call: "AbcClassUtil.classify(null)"
    expected_return: null
```

### 执行步骤

#### 总流程

```
对每个 YAML 用例文件:
  1. 读取 db_level 字段
  2. 检测 PostgreSQL 可用性
  3. 有 PG → 所有用例执行 pg_call + java_call 双端比对
  4. 无 PG → 按 db_level 选择降级策略:
     ├─ pure_java   → Step A (纯 Java 测试)
     ├─ h2_compatible → Step B (H2 集成测试)
     └─ pg_only     → status = "skipped_pg_only"
```

#### Step A: 纯 Java 测试 (db_level = pure_java)

适用于无需数据库的纯计算/纯逻辑用例。

1. 从 YAML 定位 `java_class` 和 `java_method`
2. 从 Java 项目中找到对应类和方法（通过 `grep` 搜索）
3. 在 `{reportDir}` 下生成 JUnit 测试类：

```java
// {reportDir}/L4EquivalencePureJavaTest.java
// 直接 new 对象调用方法，无需 Spring 容器或数据库

@Test
void test_fn_abc_class_A类_cumPct低于80%() {
    AbcClassService service = new AbcClassService();
    String result = service.abcClass(new BigDecimal("0.50"), null, null);
    assertEquals("A", result);
}
```

4. 执行测试：`cd {outputDir} && {TOOLS_DIR}/sql2java-mvn test -Dtest=L4EquivalencePureJavaTest`
5. 解析 surefire 报告，比对每个 case 的结果 vs `expected_return`
6. ⚠️ 清理中间产物（绝对规则 #3/#4）：

   ```bash
   # 将 target 下的中间产物移动到 baselines 保留溯源
   mkdir -p {reportDir}/l4-target
   cp -r {outputDir}/target/surefire-reports {reportDir}/l4-target/ 2>/dev/null || true
   cp -r {outputDir}/target/test-classes/L4Equivalence* {reportDir}/l4-target/ 2>/dev/null || true

   # 删除 outputDir 中的 L4 产物（还原项目到评估前状态）
   rm -rf {outputDir}/target/test-classes/L4Equivalence*
   rm -f {reportDir}/L4EquivalencePureJavaTest.java
   ```

**宽容比较规则**：

- BigDecimal 忽略 scale（10.50 == 10.5）
- NULL ≈ null ≈ 空串
   - 浮点容忍误差 0.0001
   - 有 `tolerance` 字段时使用指定精度

#### Step B: H2 集成测试 (db_level = h2_compatible)

适用于需要数据库但 SQL 在 H2 MODE=Oracle 下可执行的用例。

**关键原则**：H2 Schema 从源 SQL **动态生成**，不使用固定文件，确保适配任何数据集（tiny/mini/full）。

**B-1 动态生成 H2 Schema**：从 `{sourceDir}/../schema/` 读取 Oracle 建表 SQL，按转换规则适配为 H2：

```bash
# 定位源 SQL schema 文件（向上找 schema 目录）
SCHEMA_DIR="$(dirname {sourceDir})/schema"

# 读取 tables.sql 和 sequences.sql，按以下规则转换并写入 {reportDir}/h2-schema.sql：
#   - NUMBER(p,s) → DECIMAL(p,s) 或 BIGINT（按精度判断）
#   - VARCHAR2 → VARCHAR
#   - DATE → TIMESTAMP（H2 DATE 精度不足）
#   - PARTITION BY RANGE (...) → 移除整个分区子句
#   - Oracle 对象类型列 (t_dimension, t_tag_varray 等) → 省略该列（H2 不支持 OBJECT TYPE）
#   - CONSTRAINT 引用的对象类型 → 省略相关约束
#   - 所有 CREATE TABLE 加 IF NOT EXISTS 防止重复建表
#   - 所有 CREATE SEQUENCE 加 IF NOT EXISTS

cat "$SCHEMA_DIR/tables.sql" "$SCHEMA_DIR/sequences.sql" \
  | sed 's/NUMBER(\([0-9]*\))/BIGINT/g' \
  | sed 's/NUMBER(\([0-9]*\),\([0-9]*\))/DECIMAL(\1,\2)/g' \
  | sed 's/VARCHAR2/VARCHAR/g' \
  | ... (其他转换) \
  > {reportDir}/h2-schema.sql
```

转换规则详见下方"H2 语法适配转换规则"段落。

**B-2 注入 H2 Schema 到项目**：将 `{reportDir}/h2-schema.sql` 复制到 `{outputDir}/src/test/resources/h2-schema.sql`

**B-3 注入测试配置**：在 `{outputDir}/src/test/resources/application-test.yml` 写入：

```yaml
spring:
  profiles: test
  datasource:
    driver-class-name: org.h2.Driver
    url: jdbc:h2:mem:mfg_erp_eval;MODE=Oracle;DB_CLOSE_DELAY=-1
    username: sa
    password:
  mybatis:
    mapper-locations: classpath*:mapper/**/*.xml
    type-aliases-package: com.example.mfgerp.entity,com.example.mfgerp.type,com.example.mfgerp.dto,com.example.mfgerp.vo
    configuration:
      map-underscore-to-camel-case: true
```

**B-4 注入 setup.sql 数据**：从 YAML 的 `setup.sql` 字段提取，适配 H2 语法：

- `ON CONFLICT ... DO UPDATE SET` → `MERGE INTO ... KEY(...) VALUES(...)` （H2 MODE=Oracle 语法）
- `ON CONFLICT ... DO NOTHING` → `MERGE INTO ... KEY(...) VALUES(...)` （H2 忽略重复行）
- `RETURNING *` → 移除（H2 不支持，MyBatis 用 useGeneratedKeys 替代）
- `::date` 类型后缀 → 移除（H2 自动识别 ISO 日期字符串）
- 写入 `{outputDir}/src/test/resources/eval-setup-{suite}.sql`

**B-5 生成 @SpringBootTest 测试类**：在 `{reportDir}/L4EquivalenceH2Test.java`

```java
@SpringBootTest
@ActiveProfiles("test")
@Sql(scripts = {"classpath:h2-schema.sql", "classpath:eval-setup-{suite}.sql"})
class L4EquivalenceH2Test {
    @Autowired CoreService coreService;
    @Autowired JdbcTemplate jdbcTemplate;

    @Test
    void test_core_pkg_get_item_正常查询() {
        Optional<ItemDO> result = coreService.getItem(10001L);
        assertTrue(result.isPresent());
        assertEquals("TEST-001", result.get().getItemCode());
        assertEquals(10.50, result.get().getStdCost().doubleValue(), 0.0001);
    }

    @Test
    void test_core_pkg_get_item_不存在时抛异常() {
        assertThrows(DataNotFoundException.class, () -> coreService.getItem(99999L));
    }

    // DB 状态断言示例
    @Test
    void test_core_pkg_log_error_正常记录() {
        coreService.logError("M1001", "物料编码已存在");
        int count = jdbcTemplate.queryForObject(
            "SELECT COUNT(*) FROM t_error_log WHERE error_code = 'M1001'", Integer.class);
        assertEquals(1, count);  // 对应 expected.t_error_log.count_delta: +1
    }
}
```

**B-6 执行测试**：`cd {outputDir} && {TOOLS_DIR}/sql2java-mvn test -Dtest=L4EquivalenceH2Test -Dspring.profiles.active=test`

**B-7 解析 surefire 报告**：比对结果 vs `expected`

**B-8 ⚠️ 清理中间产物（绝对规则 #3/#4，不可跳过）**：surefire 报告解析完成后，将 `outputDir` 还原到评估前状态。注入的配置文件直接删除；`target/` 下的中间产物移动到 `{reportDir}/l4-target/` 保留溯源后从 `outputDir` 中移除：

```bash
# ── 1. 保留溯源：将 target 中间产物移动到 baselines ──
mkdir -p {reportDir}/l4-target

# surefire 报告（测试执行结果 XML/TXT）
cp -r {outputDir}/target/surefire-reports {reportDir}/l4-target/ 2>/dev/null || true

# 编译后的测试类（class 文件）
cp -r {outputDir}/target/test-classes/L4Equivalence* {reportDir}/l4-target/ 2>/dev/null || true

# 生成的测试类源文件
cp -f {reportDir}/L4EquivalencePureJavaTest.java {reportDir}/l4-target/ 2>/dev/null || true
cp -f {reportDir}/L4EquivalenceH2Test.java {reportDir}/l4-target/ 2>/dev/null || true

# ── 2. 还原 outputDir：删除注入的临时配置文件 ──
rm -f {outputDir}/src/test/resources/h2-schema.sql
rm -f {outputDir}/src/test/resources/application-test.yml
rm -f {outputDir}/src/test/resources/eval-setup-*.sql

# ── 3. 还原 outputDir：删除 target 中的 L4 产物 ──
rm -rf {outputDir}/target/test-classes/L4Equivalence*

# ── 4. 验证还原成功 ──
test ! -f {outputDir}/src/test/resources/h2-schema.sql && echo "✅ h2-schema.sql 已删除" || echo "❌ h2-schema.sql 删除失败"
test ! -f {outputDir}/src/test/resources/application-test.yml && echo "✅ application-test.yml 已删除" || echo "❌ application-test.yml 删除失败"
ls {outputDir}/src/test/resources/eval-setup-*.sql 2>/dev/null && echo "❌ eval-setup-*.sql 删除失败" || echo "✅ eval-setup-*.sql 已删除"
test -d {reportDir}/l4-target && echo "✅ 中间产物已保留到 l4-target/" || echo "❌ l4-target 目录不存在"
```

**清理原则**：

- L4 注入是临时操作（绝对规则 #3 例外），**surefire 数据提取后必须立即清理**，不可跳过
- `src/test/resources/` 下的注入配置文件 → **直接删除**（h2-schema.sql、application-test.yml、eval-setup-*.sql）
- `target/` 下的中间产物（surefire 报告、编译的测试类） → **移动到 `{reportDir}/l4-target/`** 保留溯源，然后从 `outputDir` 中删除
- 清理后 `outputDir` 必须还原到评估前状态，不得残留任何 L4 产物
- 删除前先确保 surefire 报告已解析 + `l4-summary.json` 已写入 reportDir
- 如删除失败（权限问题等），输出 ❌ 错误信息并报告，不静默跳过

#### H2 语法适配转换规则

| Oracle/PG 语法 | H2 MODE=Oracle 替代 | 影响的用例 |
|----------------|---------------------|-----------|
| `ON CONFLICT (col) DO UPDATE SET ...` | `MERGE INTO t KEY(col) VALUES(...)` | create_item, get_bom_components 等 setup.sql |
| `ON CONFLICT (col) DO NOTHING` | `MERGE INTO t KEY(col) VALUES(...)` （重复时静默忽略） | 同上 |
| `RETURNING col` | 移除，MyBatis useGeneratedKeys 处理 | create_item |
| `::date` 类型后缀 | 移除（H2 自动解析 ISO 格式） | archive_before pg_call |
| `RPAD('X', 3000, 'X')` | H2 支持 RPAD（MODE=Oracle） | log_error |
| `SUM() OVER (ORDER BY ...)` | H2 支持窗口函数 | issue_fifo |
| `WITH RECURSIVE ...` | H2 支持递归 CTE | list_bom |
| `FOR UPDATE OF col` | H2 支持（MODE=Oracle） | issue_fifo |
| `CREATE SEQUENCE IF NOT EXISTS` | H2 支持 | log_error, create_item |

#### Step C: PostgreSQL 全量比对 (有 PG 环境)

有 PostgreSQL 环境时，所有用例使用原有逻辑执行 pg_call + java_call 双端比对。

### 输出

写入 `{reportDir}/l4-summary.json`：

```json
{
  "scores": { "equivalenceRate": 88 },
  "executionMode": "degraded_h2",
  "degradedInfo": {
    "level1_pureJavaCases": 8,
    "level2_h2Cases": 30,
    "level3_pgOnlySkipped": 4,
    "pgAvailable": false
  },
  "totalCases": 42,
  "passedCases": 35,
  "failedCases": 2,
  "skippedCases": 5,
  "skippedDetail": {
    "pg_only": [
      "trg_item_audit: std_cost变化触发审计",
      "trg_item_audit: status变化触发审计",
      "trg_item_audit: 其他列变化不触发",
      "trg_item_audit: 值未变化不触发"
    ]
  },
  "details": {
    "caseResults": [
      { "suite": "fn_abc_class", "caseName": "A类_cumPct低于80%", "status": "passed", "mode": "pure_java" },
      { "suite": "fn_abc_class", "caseName": "B类_cumPct在80%-95%之间", "status": "passed", "mode": "pure_java" },
      { "suite": "core_pkg_get_item", "caseName": "正常查询_返回全部字段", "status": "passed", "mode": "h2" },
      { "suite": "core_pkg_get_item", "caseName": "不存在时抛异常", "status": "passed", "mode": "h2" },
      { "suite": "trg_item_audit", "caseName": "std_cost变化触发审计", "status": "skipped_pg_only", "mode": "pg_only" }
    ]
  }
}
```

**等价率计算**：

```
equivalenceRate = passedCases / (totalCases - skipped_pg_only) * 100
```

pg_only 跳过不计入等价率分母，仅降级可测的用例计入。

**有 PG 时的输出**（原有格式不变）：

```json
{
  "scores": { "equivalenceRate": 83 },
  "executionMode": "full_pg",
  "degradedInfo": null,
  "totalCases": 42,
  "passedCases": 35,
  "failedCases": 7,
  "skippedCases": 0
}
```

---

## 综合报告生成

### 执行步骤

1. 读取 `{reportDir}/l1-metrics.json`、`l2-summary.json`、`l3-summary.json`、`l4-summary.json`（存在哪些读哪些）
2. 计算加权总分：

```
权重: L1=0.10, L2=0.30, L3=0.35, L4=0.25
未执行的层级权重重新分配给已执行的层级

L1 得分 = firstPassRate（无数据则 50）
L2 得分 = l2.scores.total
L3 得分 = l3.scores.total
L4 得分 = l4.scores.equivalenceRate

totalScore = sum(各层得分 × 权重) / sum(已执行权重)
```

3. 评级：≥95→A+，≥85→A，≥70→B，≥50→C，<50→D
4. 生成改进建议（自动根据低分项产出）

### 输出

写入 `{reportDir}/eval-report.json` + `{reportDir}/eval-report.md`

**eval-report.md 格式**：

```markdown
# SQL2Java 转译质量评估报告

- **日期**: 2026-06-12
- **Run ID**: run-20260612-143022
- **数据集**: mfg_erp_sql_tiny (11 文件 / 412 行)
- **Java 项目**: generated-project/

## 综合评分: 91.2/100 (A)

| 层级 | 得分 | 权重 | 加权分 |
|------|------|------|--------|
| L1 转译效率度量 | 100/100 | 10% | 10.0 |
| L2 代码质量度量 | 92/100 | 30% | 27.6 |
| L3 语义分析度量 | 91/100 | 35% | 31.9 |
| L4 行为等价度量 | 88/100 | 25% | 22.0 |

## L1 转译效率度量

### 产出概览

| 指标 | 值 |
|------|-----|
| Oracle 包/子程序 | 2 包 / 15 子程序 |
| Java 文件产出 | 18 源文件 + 4 测试文件 |
| 编译成功 | ✅ |
| 首次通过率 | 100%（review 首轮无 must-fix） |
| Fix 循环 | 0 次 |
| TODO 残留 | 1 |
| review 平均分 | 88 |

### 资源消耗

| 指标 | 值 | 说明 |
|------|-----|------|
| 总耗时 | 8 分钟 | 各阶段: inventory 12s → analyze 45s → plan 35s → scaffold 28s → translate 3m → dedup 1m → review 1m15s → verify 40s |
| API 调用 | 42 次 | 工具调用 68 次 |
| Token 使用 | 308K | input 185K / output 28K / cache 95K |

### 效率指标

| 指标 | 值 | 健康范围 |
|------|-----|---------|
| 吞吐量 | 56 子程序/小时 | >40 ✅ |

### 费用明细

> ⚠️ 费用数据仅在 API 返回 cost 信息时可用。当前 run 费用为 $0.85。

| 指标 | 值 | 健康范围 |
|------|-----|---------|
| 单子程序成本 | $0.057 | $0.03~$0.10 ✅ |
| Fix 成本占比 | 0% | <15% ✅ |

## L2 代码质量度量 (评级: A)

| 指标 | 得分 | 详情 |
|------|------|------|
| TODO 残留 | 93/100 | [translate]:1, [test]:0 |
| 规约合规（含 Java 8） | 97/100 | 4 处 Checkstyle 违规，0 处 Java 8 违规 |

## L3 语义分析度量

| 指标 | 得分 | 详情 |
|------|------|------|
| SQL 覆盖率 | 87/100 | MyBatis 26/31 |
| 表覆盖率 | 95/100 | 未覆盖: t_uom_conversion |
| 子程序映射 | 93/100 | 未映射: archive_before |
| 异常映射 | 89/100 | 有效 catch 6 vs EXCEPTION 8（空catch 1 不计入） |
| 控制流 | 91/100 | 余弦相似度 0.987 |

## L4 行为等价度量 (降级模式: H2)

| 指标 | 值 |
|------|-----|
| 等价通过率 | 88% (35/38 可测用例) |
| 纯 Java 测试 | 8/8 通过 |
| H2 集成测试 | 27/30 通过 |
| PG 专用跳过 | 4 用例 (需 PostgreSQL) |
| 失败详情 | core_pkg_bulk_receive: MERGE 翻译不完整; core_pkg_issue_fifo: WHERE CURRENT OF 未翻译 |

## 改进建议

1. **子程序未映射**: `archive_before` 未找到对应 Java 方法，可能因 EXECUTE IMMEDIATE 动态 SQL 被跳过
2. **表未覆盖**: `t_uom_conversion` 在 MyBatis 中未引用，需检查 fn_uom_convert 的翻译
3. **测试失败**: 2 个测试未通过，需检查对应 ServiceImpl 逻辑
```

---

## 质量检查

- [ ] 任务参数解析：runId、sourceDir、outputDir、reportDir
- [ ] L1 转译效率度量：报告写入 `l1-metrics.json`
- [ ] L2 代码质量度量：报告写入 `l2-summary.json`
- [ ] L3 语义分析度量：报告写入 `l3-summary.json`
- [ ] L4 行为等价度量：报告写入 `l4-summary.json`
- [ ] 综合报告：含 L1~L4 四层评分和改进建议
