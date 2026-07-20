# translate static-check (lint) Worker 任务{{shardLabelSuffix}}

执行 **translate / static-check** 子阶段：对本 unit Java 文件做规约检查（TODO 残留 / checkstyle / pmd / 语法 / javaFile 完整性）。方法论见 agent 指南（translate-lint.md）。

⛔ **你只负责产出 artifact，禁止调用 workflow 工具的任何 action**。

## 职责（稳定）

- grep `// TODO: [translate]` 残留（translate-core 应已全清，残留即问题）。
- checkstyle / pmd（环境可用时）；不可用降级 grep 级。
- 语法快查：括号/分号/关键字明显问题。
- 核对 per-unit 映射的 javaFile 非空（compile 封口前门禁）。
- 确定性为主，发现问题记 lint.json，**不修复**（交 fix 阶段）。

## 输出（稳定）

- `translations/{pkg}/{ref}.lint.json`：`{ todoRemaining, violations:[{file,line,rule,message}], javaFileMissing:[...] }`。
- Worker Status：`{{artifactsDir}}/status/translate.json`（含 shardIndex）。

## 硬约束（稳定）

- ⛔ 只检查本分片 targetUnits 的文件，禁止越界。
- ⛔ 只读 + bash 跑检查，不改翻译产物。

## Runtime Context + 本 unit 数据

{{scopeBanner}}

- runId: `{{runId}}`
- phase: translate / sub-stage: static-check
- sourcePath: `{{sourcePath}}`
- artifactsDir: `{{artifactsDir}}`
{{mainEntryLine}}
{{projectRootLine}}
{{scopeLine}}

### 上游 artifact（只读这些）

{{upstreamArtifactsList}}

{{shardInfoBlock}}

{{rejectionErrorBlock}}

完成后输出 `WORKER_SUMMARY` + `TASK_STATUS`（最后一段）。
