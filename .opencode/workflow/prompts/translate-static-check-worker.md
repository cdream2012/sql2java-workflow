# translate static-check (lint) Worker 任务{{shardLabelSuffix}}

执行 **translate / static-check** 子阶段：对本 unit Java 文件做机械规约检查（TODO 残留 / checkstyle / pmd / 语法 / javaFile 完整性）+ 语义自审（对照 PL/SQL 切片核对翻译忠实度）。方法论见 agent 指南（translate-lint.md）。

⛔ **你只负责产出 artifact，禁止调用 workflow 工具的任何 action**。

## 职责（稳定）

**Step 1 机械检查**：
- grep `// TODO: [translate]` 残留（translate-core 应已全清，残留即问题）。
- checkstyle / pmd（环境可用时）；不可用降级 grep 级。
- 语法快查：括号/分号/关键字明显问题。
- 核对 per-unit 映射的 javaFile 非空（compile 封口前门禁）。

**Step 2 语义自审（LLM，对照源码）**：
- 读 per-proc Java + `shard-inputs/{pkg}/{ref}/source.sql` + 依赖签名块，按 #1-#9 语义信号（逻辑等价/SQL 完整性/空值/类型/异常/事务/游标/参数方向/命名追溯）核对翻译忠实度。

发现问题记 lint.json，**不修复**（交 fix 阶段）、**不 fail unit**（status 恒 completed）。

## 输出（稳定）

- `translations/{pkg}/{ref}.lint.json`：`{ todoRemaining, violations:[{file,line,rule,message}], javaFileMissing:[...], semanticFindings:[{signal,file,line,severity,issue}], selfReviewPassed: boolean }`。
- ⛔ **不写 `status/translate.json`**——那是 translator master 的 advance 完成门控文件，仅 master 在 6 sub-stage 全过后写一次；slave 写会 clobber 门控、触发误 advance。你只在最后一段文本回 `TASK_STATUS` 给 master。

## 硬约束（稳定）

- ⛔ 只检查本分片 targetUnits 的文件，禁止越界。
- ⛔ 源码只读 `shard-inputs/{pkg}/{ref}/source.sql`；只读 + bash 跑检查，不改翻译产物。
- ⛔ **禁止 glob/ls/find/Grep 扫描 `src/`、`translations/`、`generated/` 目录**（数百文件平铺，一扫即爆上下文）；只 read 下方「本 unit 文件清单」列出的绝对路径。

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

{{unitFilesBlock}}

{{rejectionErrorBlock}}

完成后输出 `WORKER_SUMMARY` + `TASK_STATUS`（最后一段）。
