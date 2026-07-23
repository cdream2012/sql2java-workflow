# translate fsd Worker 任务{{shardLabelSuffix}}

执行 **translate / fsd** 子阶段：为本 unit 生成 FSD 功能说明书（人工审核用，孤立产出）。方法论见 agent 指南（translate-fsd.md）。

⛔ **你只负责产出 artifact，禁止调用 workflow 工具的任何 action**。

## 职责（稳定）

读本 unit 源码 + 翻译决策，按 6 板块模板填空生成 FSD：
1. **概览**：子程序表格 + 签名 + 参数清单表
2. **表结构映射**：表名|操作|关键条件|说明
3. **依赖分析**：目标包|目标子程序 refName|功能（只记客观调用，见依赖签名块）
4. **业务规则**：校验/计算/边界
5. **控制流与异常**：文字或 Mermaid + 异常路径表
6. **特殊语法转化规约**：PL/SQL 构造|位置|Java 等价|风险 + 事务边界 + 需手动审查构造表

## FSD 固定收尾格式（稳定，严格遵守）

每个 FSD 文件末尾必须含：

```markdown
### 6.3 需手动审查的构造

| 构造 | 位置 | 原因 | 建议 |
|------|------|------|------|
| （无） | — | — | — |
```

有则填具体行，无则保留"（无）"。禁止 TODO/checkbox 替代。每个板块写实质内容，禁止"详见"占位。

## 输出（稳定）

- FSD 文件：`fsd/{pkg}/{ref}.md`（refName 用 inventory 算好的，重载带 `__序号`）
- ⛔ **不写 `status/translate.json`**——那是 translator master 的 advance 完成门控文件，仅 master 在 6 sub-stage 全过后写一次；slave 写会 clobber 门控、触发误 advance。你只在最后一段文本回 `TASK_STATUS` 给 master。

## 硬约束（稳定）

- ⛔ 只处理本分片 targetUnits，禁止越界
- ⛔ 源码只读 `shard-inputs/{pkg}/{ref}/source.sql`；决策读 per-unit `translations/{pkg}/{ref}.json`
- ⛔ 不改翻译产物，禁止 workflow action
- ⛔ **禁止 glob/ls/find/Grep 扫描 `src/`、`translations/`、`generated/` 目录**（数百文件平铺，一扫即爆上下文）；只 read 下方「本 unit 文件清单」列出的绝对路径。

## Runtime Context + 本 unit 数据

{{scopeBanner}}

- runId: `{{runId}}`
- phase: translate / sub-stage: fsd
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

{{unitFilesBlock}}

{{rejectionErrorBlock}}

完成后输出 `WORKER_SUMMARY` + `TASK_STATUS`（最后一段）。
