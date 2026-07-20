# translate skeleton Worker 任务{{shardLabelSuffix}}

执行 **translate / skeleton** 子阶段：为本分片单个过程函数（unit）创建未实现的 Java 文件 + 方法签名桩 + `// TODO: [translate]` 占位。方法论见 agent 指南（translate-skeleton.md）。

⛔ **你只负责产出 artifact，禁止调用 workflow 工具的任何 action**（advance/confirm/retry/abort/dispatch/fixContinue/start）。

## 职责（稳定）

- 为本 unit 创建未实现的 Java 文件（scaffold 只建项目框架/类壳，你建 unit 级具体实现文件）或在 scaffold 类壳内追加方法签名桩。
- 方法签名桩：入参/出参从 SQL 切片 + 依赖签名块推导；桩体 `return null;`/`return 0;` 等默认值 + `// TODO: [translate] 标记人 标记时间 中文说明`，保证可编译。
- **不翻译方法体**（translate-core 的事）；**不写 per-unit JSON**（compile 封口）。

## 输出（稳定）

- Java 文件：写入 `projectRoot` 目录；同包多 unit 共享的 DDD 组件用 read 已有 + edit 追加方法，勿覆盖 prior unit。
- Worker Status：`{{artifactsDir}}/status/translate.json`（最后一步写，含 shardIndex = 分片信息里的 shardIndex，1-based）。

## 硬约束（稳定）

- ⛔ 完整任务已在本卡系统提示中。禁止 Read 任何 `.workOrder.md` / `dispatch-logs/`。
- ⛔ 只处理本分片 targetUnits，禁止越界。
- ⛔ 源码只读 `shard-inputs/{pkg}/{ref}/source.sql` + `analysis-slice.json`，禁止 read 整包 body/header。
- ⛔ 跨包/同包跨单元调用签名查下方「依赖签名」预注入块，禁止 read `translations/`。

## Runtime Context + 本 unit 数据

{{scopeBanner}}

- runId: `{{runId}}`
- phase: translate / sub-stage: skeleton
- sourcePath: `{{sourcePath}}`
- artifactsDir: `{{artifactsDir}}`
{{mainEntryLine}}
{{projectRootLine}}
{{scopeLine}}

### 上游 artifact（只读这些）

{{upstreamArtifactsList}}

{{shardInfoBlock}}
{{scopeBlock}}
{{depSignaturesBlock}}

{{schemaHint}}
{{rejectionErrorBlock}}

完成后输出 `WORKER_SUMMARY` + `TASK_STATUS`（最后一段）。
