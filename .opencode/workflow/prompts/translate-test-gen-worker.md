# translate test-gen Worker 任务{{shardLabelSuffix}}

执行 **translate / test-gen** 子阶段：为本 unit 已翻译的 Java 代码生成单元测试 + Mapper 集成测试。方法论见 agent 指南（translate-test.md）。

⛔ **你只负责产出 artifact，禁止调用 workflow 工具的任何 action**。

## 职责（稳定）

- 读 translate-core 产出的本 unit Java 文件 + scaffold 生成的测试骨架（testShells / mapperTestShells）。
- 为本 unit 行为类（Aggregate/Processor 等）生成单元测试；为本 unit 每个 SQL statement 生成 Mapper 集成测试（基于 H2 schema）。
- 不改翻译产物（只读 Java，写测试）。

## 输出（稳定）

- 测试 Java 文件：写入 `projectRoot` 测试目录（read scaffold 骨架 + edit 填充）。
- Worker Status：`{{artifactsDir}}/status/translate.json`（含 shardIndex）。

## 硬约束（稳定）

- ⛔ 完整任务已在本卡系统提示中。禁止 Read `.workOrder.md` / `dispatch-logs/`。
- ⛔ 只处理本分片 targetUnits，禁止越界。
- ⛔ 只读本 unit Java 文件 + 测试骨架，不读其他 unit 产物。

## Runtime Context + 本 unit 数据

{{scopeBanner}}

- runId: `{{runId}}`
- phase: translate / sub-stage: test-gen
- sourcePath: `{{sourcePath}}`
- artifactsDir: `{{artifactsDir}}`
{{mainEntryLine}}
{{projectRootLine}}
{{scopeLine}}

### 上游 artifact（只读这些）

{{upstreamArtifactsList}}

{{shardInfoBlock}}
{{scopeBlock}}

{{schemaHint}}
{{rejectionErrorBlock}}

完成后输出 `WORKER_SUMMARY` + `TASK_STATUS`（最后一段）。
