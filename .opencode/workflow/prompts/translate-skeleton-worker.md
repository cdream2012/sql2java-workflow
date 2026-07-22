# translate skeleton Worker 任务{{shardLabelSuffix}}

执行 **translate / skeleton** 子阶段：为本分片单个过程函数（unit）创建未实现的 Java 文件 + 方法签名桩 + `// TODO: [translate]` 占位。方法论见 agent 指南（translate-skeleton.md）。

⛔ **你只负责产出 artifact，禁止调用 workflow 工具的任何 action**（advance/confirm/retry/abort/dispatch/fixContinue/start）。

## 职责（稳定）

- 为本 unit（单个过程/函数）创建**未实现的 per-proc Java 文件**——按规约 §一/§3.2 的 per-proc 角色集，每个角色一个独立文件（一 public 类一文件）。scaffold 只建项目框架/全局公共件/per-package 状态持有类，**不建 per-proc 业务类**——你直接 `write` 建 per-proc 类壳。
- 类名 = `{ProcPascal}{RoleSuffix}`（规约 §4.1 派生），路径 = `{projectRoot}/src/main/java/{javaPackage 以 / 分隔}/{ProcPascal}{RoleSuffix}.java`；Mapper 角色额外建 XML（namespace = `{javaPackage}.{ProcPascal}Mapper`）。类名/路径查 `scaffold.json.packageMappings`（`plsqlSchema`/`javaPackage`/`components[]` 角色集）。
- 方法签名桩：入参/出参从 SQL 切片 + 依赖签名块推导；桩体 `return null;`/`return 0;` 等默认值 + `// TODO: [translate] 标记人 标记时间 中文说明`，保证可编译。
- 包级常量/变量只读引用 scaffold 的 `{Pkg}State`（不重建/不修改）。
- **不翻译方法体**（translate-core 的事）；**不写 per-unit JSON**（compile 封口）。

## 输出（稳定）

- per-proc Java 文件 + Mapper XML：`write` 到 `projectRoot` 目录。每个 unit 的类文件各占一文件、互不共享（无 read-or-create；同包不同 unit 落不同 per-proc 文件，天然无冲突）。
- ⛔ **不写 `status/translate.json`**——那是 translator master 的 advance 完成门控文件，仅 master 在 6 sub-stage 全过后写一次；slave 写会 clobber 门控、触发误 advance。你只在最后一段文本回 `TASK_STATUS` 给 master。

## 硬约束（稳定）

- ⛔ 完整任务已在本卡系统提示中。禁止 Read 任何 `.workOrder.md` / `dispatch-logs/`。
- ⛔ 只处理本分片 targetUnits，禁止越界。
- ⛔ 源码只读 `shard-inputs/{pkg}/{ref}/source.sql`，禁止 read 整包 body/header。
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
