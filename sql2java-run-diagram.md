# SQL2Java 工作流完整执行流程

> 用户在 opencode 中输入 `/sql2java 请帮我转译项目为java，项目路径为/path/to/project` 后的完整执行流程说明。

---

## 一、命令识别与参数解析（入口）

**文件：`.opencode/command/sql2java.md`**

当用户在 opencode 中输入 `/sql2java 请帮我转译项目为java，项目路径为/path/to/project` 时：

1. **opencode 框架**识别到 `/sql2java` 斜杠命令，加载 `.opencode/command/sql2java.md` 作为该命令的执行指令
2. LLM 解析 `$ARGUMENTS`（即 `请帮我转译项目为java，项目路径为/path/to/project`）
3. **路由判定**：参数中不含 `status`、`resume` 关键字，不含已知阶段名（inventory/analyze/...），但包含一个路径字符串 → 命中 **分支 4：默认全流程**

---

## 二、分支 4 预检（命令层）

在真正启动工作流前，命令层（LLM 作为执行引擎）执行两步校验：

### Step 1：校验路径有效性

```bash
find /path/to/project -type f \( -name "*.sql" -o -name "*.pks" -o -name "*.pkb" \) | head -5
```

- 如果没有找到任何文件 → 报错退出
- 找到文件 → 继续下一步

### Step 2：生成 runId

```bash
date -u +%Y%m%d-%H%M%S
```

生成格式如 `run-20260602-143000`

---

## 三、启动工作流引擎

**文件：`.opencode/plugins/workflow-engine.ts` + `.opencode/workflow/engine-core.ts`**

### Step 3：调用 `workflow({ action: "start", runId: "run-20260602-143000", sourcePath: "/path/to/project" })`

执行流程：

1. **插件层**（`plugins/workflow-engine.ts`）：
   - 尝试 `engine.loadFromDisk(runId)` — 如果磁盘上已有同 runId 的 `run.json` 则恢复
   - 没有已存在的 → 调用 `engine.start("sql2java", runId, { sourcePath })`

2. **引擎层**（`workflow/engine-core.ts`）：
   - 查找 `sql2java` 工作流定义（已注册在 `WorkflowEngine` 单例中）
   - 获取第一个阶段 `inventory`
   - 创建 `WorkflowRun` 对象：
     ```
     runId: "run-20260602-143000"
     status: "running"
     currentPhase: "inventory"
     phaseHistory: [{ phase: "inventory", status: "in_progress", retryCount: 0 }]
     metadata: { sourcePath: "/path/to/project" }
     ```
   - **持久化**到 `.workflow-artifacts/run-20260602-143000/run.json`
   - **追加事件日志**到 `_events.log`

3. **设置工作流上下文**（`setWorkflowContext`）：
   ```
   currentWorkflowContext = {
     runId: "run-20260602-143000",
     phase: "inventory",
     agentFile: "agent/sql-analyst.md",
     temperature: 0.1,
   }
   ```

---

## 四、System Prompt 构建（Hook 注入）

**文件：`.opencode/plugins/workflow-engine.ts`**

引擎启动后，opencode 框架在构建下一次 LLM 请求时触发 `experimental.chat.system.transform` hook：

1. **读取 agent 文件**：`.opencode/agent/sql-analyst.md`
2. **提取通用部分**（`extractCommonPart`）：文件开头到第一个 `## Phase:` 之前的内容 — 包含角色定义、绝对规则、Runtime Context 说明、Artifact 写入规则、Oracle 构造识别参考等
3. **提取当前阶段内容**（`extractPhaseSection`）：`## Phase: inventory` 整个 section — 包含目标、输入输出、工作步骤、质量检查
4. **构建 Runtime Context**（`buildRuntimeContext`）：
   ```
   currentPhase: inventory
   runId: run-20260602-143000
   sourcePath: /path/to/project
   artifactsDir: .workflow-artifacts/run-20260602-143000
   ```
5. **拼接最终 system prompt**：`通用部分 + Phase Section + Runtime Context`

同时 `chat.params` hook 生效：
- **温度控制**：temperature = 0.1
- **工具过滤**：只允许 `["read", "bash", "write", "workflow"]`

---

## 五、阶段 1：inventory（编目）

**Agent：sql-analyst.md → Phase: inventory**

此时 LLM 以 sql-analyst 身份，遵循 system prompt 中的指令执行：

1. **读取预扫描索引**：`inventory-index.json`（start 时已由引擎自动生成）
2. **分批处理**：每批 2-3 个包，只读当前批次的源码，处理完立即写入磁盘
3. **逐文件解析**：识别 Package spec/body、DDL、Trigger、View、Sequence、独立子程序
4. **提取包结构**：每个 Package 的过程/函数签名、参数（name, oracleType, direction）、返回类型、行号范围
5. **提取表结构**：列名、Oracle 类型、是否可空、是否主键
6. **提取其他对象**：触发器、视图、序列
7. **写入 per-package 文件**：`inventory-packages/{PKG}.json`（逐包持久化）
8. **写入索引文件**：`inventory.json`（索引 packageNames + DDL 数据 tables/triggers/views/sequences）

完成后调用：

```javascript
workflow({ action: "advance", runId: "run-20260602-143000", result: "passed" })
```

### advance 内部流程（`workflow/engine-core.ts`）

1. **验证** run.status === "running"
2. **Zod 校验**（D5）：`validateArtifactOnDisk` 从磁盘读取 artifact，用对应 Schema 校验
   - 校验失败 → 返回 rejection，LLM 需修复 artifact
   - 校验通过 → 继续
   - 注：`getArtifactFilename`（D14）将 phase 名映射为磁盘文件名（如 `analyze` → `analysis.json`）
3. **跨 Schema 校验**（D9）：inventory 完成后由 plugin 层 `validateInventoryPackages` 校验 index↔inventory 一致性
4. **完成当前 entry**：`status: "completed"`
5. **匹配 TransitionRule**：`inventory → condition: "always" → analyze`
6. **创建新 entry**：`{ phase: "analyze", status: "in_progress" }`
7. **更新 run**：`currentPhase = "analyze"`
8. **持久化** `run.json`（D6）
9. **设置工作流上下文**：`phase: "analyze"`, `agentFile: "agent/sql-analyst.md"`, `temperature: 0.1`
10. **清除 artifact 缓存**（D17）

返回 `→ analyze`，LLM 进入下一阶段。

---

## 六、阶段 2：analyze（依赖分析 + FSD 生成）

**Agent：sql-analyst.md → Phase: analyze**

System prompt 重新构建，注入 analyze phase section + Runtime Context（含 `upstreamArtifacts: inventory-index.json + inventory.json + inventory-packages/*.json`）。

内部分三轮（分批处理，每批 2-3 个包）：

### 第一轮：全局依赖图 + 拓扑排序

- 从源码中提取跨包调用关系 → `callGraph`
- 推导包级依赖 → `packageDependency`
- 拓扑排序 + SCC 检测 → `translationOrder`（`[["pkg_utils"], ["order_proc", "order_util"], ...]`）
- 复杂度评估 → `complexity`
- SCC 组记录 → `sccGroups`

### 第二轮：逐包子程序结构解析

- 对每个包的每个子程序解析：blocks、variables、cursors、exceptionHandlers、translationNotes
- 每完成一个包立即写入 `analysis-packages/{pkg}.json`（逐包持久化）

### 第三轮：逐子程序 FSD 文档生成

- 对每个子程序生成 6 板块 FSD 文档，写入 `fsd/{package}/{subprogram}.md`
- 每完成一个子程序立即写入磁盘，避免中途崩溃丢失

### 最终写入全局 `analysis.json`

`analysis.json` 只保留全局元数据（callGraph + topology + complexity + packageNames），子程序数据在 per-package 文件中。

完成后调用 `workflow({ action: "advance", runId, result: "passed" })`

**advance 处理**：

- Zod 校验 `analysis.json`（通过 `getArtifactFilename("analyze")` → `analysis.json`，D14）
- 跨 Schema 校验（D9）：inventory 包名 ↔ analysis 包名双向一致性（`extractPackageNames` 双格式兼容）、translationOrder 覆盖校验
- 匹配规则：`analyze → condition: "always" → plan`
- 新 entry：`{ phase: "plan", status: "pending" }`
- **plan 有 `requiresConfirmation: true`** → run.status 设为 `"paused"`，返回 `waitingForConfirmation: true`

---

## 七、阶段 3：plan（架构规划）— 暂停等待确认

**注意**：plan 阶段不是直接执行的。引擎返回 `waitingForConfirmation: true` 后（D4）：

**命令层（sql2java.md 分支 4）** 向用户输出提示：

> Plan 阶段等待确认。请审阅 plan.json 后调用：
> `workflow({ action: "confirm", runId: "run-20260602-143000" })`

**时序说明**：analyze advance 后 plan entry 以 `status: "pending"` 创建，run.status 设为 `"paused"`。此时**不切换 system prompt，不激活 agent**。用户确认后，`confirm()` 将 entry 改为 `"in_progress"`、run.status 改为 `"running"`，然后才构建 java-architect 的 system prompt 并激活 agent。

LLM **以 java-architect 身份执行 plan 阶段**的工作：

1. 读取 `inventory-index.json` + `inventory-packages/*.json` + `analysis.json` + `analysis-packages/*.json` + FSD 文档（可选）
2. 确定 Java 项目配置（groupId, artifactId, packageBase...）
3. 设计包映射：每个 Oracle Package → Mapper + Service + ServiceImpl
4. 确定规则（命名约定、空值处理、异常策略、日志框架）
5. 生成类型映射
6. 标记需人工审查的子程序
7. 写入 `plan.json`

完成后调用 `workflow({ action: "advance", runId, result: "passed" })`

**advance 处理**：

- Zod 校验 `plan.json` → `PlanSchema`
- 跨 Schema 校验（D9）：plan 的 packageMappings 覆盖 inventory 所有包
- 匹配规则：`plan → condition: "always" → scaffold`
- 创建 scaffold entry → 直接前进（scaffold 无 requiresConfirmation）

---

## 八、阶段 4：scaffold（骨架生成）

**Agent：java-architect.md → Phase: scaffold**

1. 创建 Maven 项目目录结构
2. 生成 `pom.xml`（Spring Boot + MyBatis 依赖）
3. 生成公共模块（异常体系、配置类）
4. 从 inventory 的 tables 生成 Entity 类
5. 为每个 Oracle Package 生成 Mapper 接口 + XML 空壳
6. 为每个 Oracle Package 生成 Service 接口 + ServiceImpl 空壳
7. 写入 `scaffold.json`

完成后调用 `workflow({ action: "advance", runId, result: "passed" })`

**advance**：`scaffold → condition: "always" → translate`，直接前进。

---

## 九、阶段 5：translate（翻译）

**Agent：translator.md → Phase: translate**

工具：`["read", "bash", "write", "edit", "workflow"]`

1. 读取 `plan.json`（映射规则）、`analysis.json`（translationOrder）、`scaffold.json`（项目骨架）
2. **按拓扑序逐包翻译**：
   - 对每个包的每个子程序，参考 blocks/cursors/exceptionHandlers
   - 遵循翻译五原则（不重构、不优化、不合并、不省略、不猜测）
   - 生成 Mapper 接口 + Mapper XML + Service + ServiceImpl + DTO
3. **逐包持久化**：每翻译完一个包立即写入 `translations/{package}/translation.json` + Java 文件

完成后调用 `workflow({ action: "advance", runId, result: "passed" })`

**advance**：`translate → condition: "always" → review`

---

## 十、阶段 6：review（质量审查）

**Agent：reviewer.md → Phase: review**

1. 确定审查范围（全量 or 增量）
2. **逐包审查**：对每个包按 10 类审查清单逐项检查（逻辑等价、SQL 完整性、空值处理、类型映射、异常映射、事务边界、游标映射、参数方向、命名一致性、TODO 残留）
3. 写入 per-package `review.json`
4. 写入 `review-summary.json`（含 `allPassed` 字段）

完成后调用 `workflow({ action: "advance", runId })`（不显式传 result）

**advance 处理**（review 阶段特殊逻辑）：

- **D8：result 推导** — 引擎读取 `review-summary.json` 的 `allPassed`
  - `allPassed = true` → result = `"passed"` → `review → condition: "passed" → verify`
  - `allPassed = false` → result = `"failed"` → `review → condition: "failed" → fix`

---

## 十一、阶段 7：verify（编译验证）

**Agent：reviewer.md → Phase: verify**

1. 执行 `mvn compile`，收集编译错误
2. 逐包校验：MyBatis XML namespace / statement id 匹配、编译错误归因、TODO 残留统计
3. 生成测试骨架
4. 写入 per-package `verify.json` + `verify-summary.json`

完成后调用 `workflow({ action: "advance", runId })`

**advance**：

- `allPassed = true` → `verify → condition: "passed" → "__done__"` → **工作流完成**
- `allPassed = false` → `verify → condition: "failed" → fix`

---

## 十二、fix 循环（条件分支）

当 review 或 verify 阶段失败时进入 fix 阶段。

### fix 入口检查

**advance 时**（`workflow/engine-core.ts`）：在创建 fix entry 前，检查 **D2 双层 exhausted**：

- 全局 fix 次数 ≤ 3（`FIX_LIMITS.globalMax`）
- 单触发阶段 fix 次数 ≤ 2（`FIX_LIMITS.phaseMax`）
- 超限 → 直接标记 `completed_with_issues`，工作流结束
- fix 入口还检查前置 artifact（D15: `checkPrerequisites`）：fix 需要触发阶段的 summary 文件（`review-summary.json` 或 `verify-summary.json`，二选一即可）

### fix 执行（translator.md → Phase: fix）

1. 读取触发阶段的 summary，获取所有 `passed=false` 的包
2. 读取每个失败包的 mustFix 列表
3. 逐包修复 Java 代码
4. 写入 `fix.json`（包含 `fixedPackages` 列表）
5. 调用 `workflow({ action: "advance", runId, result: "passed" })`（result 必填）

### fix advance 特殊处理（`handleFixAdvance`）

- **D5 fix-failed 特殊处理**：fix 阶段 result="failed" 时跳过 artifact Zod 校验（agent 可能无法写出有效的 fix.json）
- **D12 校验**：
  - `fix.json` 必须存在且 `fixedPackages` 非空
  - 包名必须存在于 inventory 中（`extractPackageNames` 双格式兼容）
  - `fixedPackages` 必须覆盖所有失败包
  - 校验失败 → rejected，LLM 需修正后重新 advance
- **D3/D7 增量回环**：fix passed 后，创建触发阶段的新 entry：
  ```
  { phase: "review" (或 "verify"), status: "in_progress",
    incrementalContext: { targetPackages: ["PKG_ORDER", "PKG_PAYMENT"] } }
  ```
  → 回到触发阶段，**只重新处理修复过的包**（增量模式）
- **D14 文件名映射**：`getArtifactFilename` 确保 fix → `fix.json` 的正确映射

### fix 失败处理

- fix 阶段 result="failed"：
  - 未 exhausted → fixFailed=true（区别于 rejected），提示 LLM 调用 retry
  - retry 时（D16）：清理残留 `fix.json`、重置 entry status + completedAt、递增 retryCount
  - retry 次数 ≥ maxRetries → exhausted → `completed_with_issues`

---

## 十三、工作流完成

当 verify passed 且 advance 匹配到 `to: "__done__"` 时：

- `run.status = "completed"`
- `run.currentPhase = null`
- 持久化 `run.json`
- `clearWorkflowContext()`
- 向用户返回完成通知

---

## 整体流程图

```
用户输入: /sql2java 请帮我转译项目为java，项目路径为/path/to/project
  │
  ▼
命令解析 → 分支 4（默认全流程）
  │
  ├─ 校验路径含 .sql/.pks/.pkb 文件
  ├─ 生成 runId: run-YYYYMMDD-HHmmss
  │
  ▼
workflow({ action: "start", runId, sourcePath })
  │  引擎: 创建 WorkflowRun, currentPhase="inventory", status="running"
  │  持久化: .workflow-artifacts/{runId}/run.json
  │  Hook: 构建 system prompt (agent/sql-analyst.md + inventory section + Runtime Context)
  │
  ▼
① inventory (sql-analyst, temp=0.1)
  │  读预扫描索引 → 分批补充语义 → 写入 inventory-packages/{PKG}.json + inventory.json
  │  advance → Zod 校验 + validateInventoryPackages → inventory→analyze (always)
  │
  ▼
② analyze (sql-analyst, temp=0.1)
  │  依赖图 + 拓扑排序 + 逐包子程序解析 + 逐子程序 FSD → analysis-packages/{pkg}.json + analysis.json + fsd/
  │  advance → Zod 校验 + 跨 Schema 校验（D9）→ analyze→plan (always)
  │
  ▼
③ plan (java-architect, temp=0.2)
  │  架构规划 → 写入 plan.json（需人工确认）
  │  advance → 跨 Schema 校验（D9）→ requiresConfirmation=true → status="paused"（D4）
  │  ⏸️ 不激活 agent，等待用户确认
  │  用户调用 confirm → status="running" → 激活 agent
  │
  ▼
④ scaffold (java-architect, temp=0.2)
  │  生成 Maven 项目骨架 → 写入 scaffold.json + Java 文件
  │  advance → scaffold→translate (always)
  │
  ▼
⑤ translate (translator, temp=0.1)
  │  按拓扑序逐包翻译 → 写入 translations/{pkg}/translation.json + Java 文件
  │  advance → translate→review (always)
  │
  ▼
⑥ review (reviewer, temp=0.1)
  │  10 类审查清单逐包审查 → review.json + review-summary.json
  │  advance → D8 推导 allPassed
  │     ├─ passed → review→verify
  │     └─ failed → review→fix ←──┐
  │                                │
  ▼                               │
⑦ verify (reviewer, temp=0.1)     │
  │  mvn compile + MyBatis 校验    │
  │  advance → D8 推导 allPassed   │
  │     ├─ passed → __done__ ✅    │
  │     └─ failed → fix ←─────────┤
  │                                │
  ▼                                │
⑧ fix (translator, temp=0.1) ─────┘
  │  D2 检查: 全局≤3次, 单阶段≤2次
  │  修复 mustFix → 写入 fix.json
  │  D12 校验 → 增量回到触发阶段（只处理修复包）
  │  循环直到 verify passed 或 exhausted → completed_with_issues
```

---

## 关键设计点总结

| 编号 | 设计点 | 说明 |
|------|--------|------|
| D1 | advance condition | 先匹配精确 condition（passed/failed），再匹配 always |
| D2 | fix 双层 exhausted | 全局最多 3 次 fix，单触发阶段最多 2 次 |
| D3 | fix 增量重做 | fix 后只重新处理修复过的包（targetPackages）；fix 失败返回 fixFailed=true |
| D4 | confirm 时序 | waitingForConfirmation=true 时不激活 agent，用户确认后才构建 prompt |
| D5 | Zod 校验 | advance 时从磁盘读 artifact 做 Zod 结构校验；fix-failed 时跳过 |
| D6 | 持久化 | 每次状态变更都写 run.json + _events.log，支持崩溃恢复 |
| D7 | fix 动态路由 | fix 不写死 transitions，由 handleFixAdvance 根据 branchedFrom 动态回环 |
| D8 | result 推导 | review/verify 阶段从 summary 的 allPassed 自动推导 result（deriveReviewResult） |
| D9 | 跨 Schema 校验 | inventory ↔ analysis ↔ plan 的包名一致性（extractPackageNames 双格式兼容） |
| D11 | system prompt 构建 | 通用部分 + Phase Section + Runtime Context 拼接注入 |
| D12 | fix 包名校验 | fixedPackages 必须存在于 inventory 且覆盖所有失败包 |
| D14 | phase→filename | getArtifactFilename 处理 phase 名与磁盘文件名不一致 |
| D15 | OR 前置 | PHASE_PREREQUISITES 支持 string[] 组内二选一（如 fix 的 summary 文件） |
| D16 | fix retry 清理 | retry 时清理残留 fix.json，重置 entry status + completedAt |
| D17 | artifact 缓存 | loadArtifactJson 单次 advance 内缓存，advance 结束后清除 |
