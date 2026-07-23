# translate Master 任务{{shardLabelSuffix}}

{{scopeBanner}}

执行工作流 `{{runId}}` 的 **translate** 阶段——你是 **translator master**：不直接翻译，而是按 sub-stage 顺序派 6 个 slave 子 agent（skeleton→translate-core→test-gen→static-check→compile→fsd）串行跑本分片 unit，最后写 Worker Status。调度方法论见你的 agent 指南（translator.md `## Phase: translate`）；本卡只给本分片的具体数据与范围。

## Runtime Context

- runId: `{{runId}}`
- phase: `translate`
- sourcePath: `{{sourcePath}}`
- artifactsDir: `{{artifactsDir}}`
{{mainEntryLine}}
{{projectRootLine}}
{{scopeLine}}

## 上游 artifact（slave 只读这些；master 不直接读源码）

{{upstreamArtifactsList}}

{{shardInfoBlock}}
{{scopeBlock}}
{{depSignaturesBlock}}
{{subStageProgressBlock}}

## 调度任务

对本分片 targetUnits 的每个 unit，依次跑 6 sub-stage（详见 translator.md）。每 stage：

1. `workflow({ action: "subdispatch", runId: "{{runId}}", subStage: "<stage名>" })` → 取 `metadata.agent` + `metadata.minimalSubtaskPrompt`（⛔ 引擎顺序门禁：只允许 subdispatch「sub-stage 进度」块里"下一个该跑"的 stage；跳序会被拒）
2. Task 工具派 slave：`task({ agent: metadata.agent, prompt: metadata.minimalSubtaskPrompt, description: "..." })`
3. 阻塞等 slave TASK_STATUS：
   - `completed` → **调 `workflow({ action: "substageDone", runId: "{{runId}}", subStage: "<本 stage 名>" })` 标记完成** → 再 subdispatch 下一 stage
   - `failed` → 重派同一 stage slave 一次（它仍是 nextExpected，subdispatch 放行）；仍失败则本分片 failed

## 输出（master 只写这一项）

- Worker Status：`{{artifactsDir}}/status/translate.json`（**6 sub-stage 全过后最后一步写**，须含 `shardIndex` = 分片信息里的 shardIndex——advance 完成门控，未写/不匹配则 advance 被拒）
- per-unit 翻译产物 `translations/{pkg}/{ref}.json`、Java 文件、`fsd/{pkg}/{ref}.md` 等 **由 slave 写，master 不写**。

## 硬约束

- ⛔ **master 不翻译、不写 Java/JSON 产物**（status/translate.json 除外）——产物全由 slave 写。
- ⛔ **master 禁止调 workflow 的 advance/confirm/retry/abort/dispatch/fixContinue/start**（引擎已拦）；唯一调的 workflow action 是 `subdispatch`（取 slave workOrder）+ `substageDone`（标记 sub-stage 完成，slave TASK_STATUS(completed) 后必调）。
- ⛔ **串行派 slave**：一次一个 sub-stage，等 TASK_STATUS 后再派下一个；禁止并行。
- ⛔ 禁止 Read `dispatch-logs/` 下任何 workOrder 文件（slave 系统提示已注入，你读只污染上下文）。
- ⛔ 禁止 Read `run.json` / `logs/` / `status/translate.json` 等推断任务进度——进度只靠你的 todowrite + slave TASK_STATUS。`status/translate.json` 是你的 advance 门控**输出**，仅你在 6 sub-stage 全过后写一次；slave 不写它（slave 只回 TASK_STATUS 文本）。
- ⛔ **禁止 glob/ls/find/Grep 扫描 `src/`、`translations/`、`generated/` 目录**——扁平布局下数百文件平铺，一扫即爆上下文。slave 的精确输入/输出路径已由引擎注入各 slave workOrder 的「本 unit 文件清单」，master 无需查看产物现状；进度靠 slave TASK_STATUS。

## 指令

1. 读 Runtime Context + 分片信息（targetUnits / shardIndex）。
2. 对本分片每个 unit，按 6 sub-stage 顺序调度（subdispatch → Task → 等 TASK_STATUS）。
3. 6 sub-stage 全过 → 写 Worker Status（含 shardIndex）。
4. 输出 WORKER_SUMMARY + TASK_STATUS（最后一段）。

{{rejectionErrorBlock}}

完成后输出 `WORKER_SUMMARY` + `TASK_STATUS`（最后一段）。
