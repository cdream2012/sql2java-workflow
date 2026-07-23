# Project Spec — fsd 子阶段（功能说明书生成）

> 本规约由引擎注入 translate-fsd 子 agent 系统提示词。融合自《待办逻辑填充详细设计生成规约》文档结构侧与注释规范，已适配本工作流。FSD 供**人工审核**翻译质量用，**孤立产出**——不回填影响翻译，translate-core 不读 FSD。

## 一、定位

为本 unit 生成 FSD（Functional Specification Document）功能说明书。读源码 `shard-inputs/{pkg}/{ref}/source.sql` + 翻译决策 `translations/{pkg}/{ref}.json` 的 `decisions`（line/plsqlConstruct/javaConstruct/reason/confidence）+ 依赖签名块（callGraph 内联），按 6 板块模板填空。

## 二、6 板块固定格式（模板填空，不自由发挥排版）

1. **概览**：子程序表格（名/类型/功能摘要/翻译策略）+ 签名代码块 + 参数清单表（参数名|方向|PL/SQL 类型|Java 类型|说明）。
2. **表结构映射**：表格（表名|操作|关键条件|说明）+ 关键列。纯逻辑函数写"不涉及表操作"。
3. **依赖分析**：表格（目标包|目标子程序 refName|功能）+ 序列/常量依赖。无依赖写"无"。只记客观调用关系（见依赖签名块），不预估 Java 映射。
4. **业务规则**：编号列表/表格列校验规则、计算逻辑、边界条件。
5. **控制流与异常**：简单子程序文字描述；复杂（>3 分支或含循环）用 Mermaid 流程图 + 异常路径表。
6. **特殊语法转化规约**：转化映射表（PL/SQL 构造|位置|Java/MyBatis 等价|风险）+ 事务边界 + "需手动审查的构造"固定收尾表。

## 三、板块 6 固定收尾（严格遵守）

`### 6.3 需手动审查的构造` 表格——无则填"（无）"，**禁止用 TODO/checkbox 替代**。

## 四、板块 6 填充要点

- **decisions 是板块 6 的结构化来源**：对照 decisions 的 `plsqlConstruct`/`javaConstruct`/`reason` 填转化映射表。
- **存储过程调用**（CALL/跨包 PROCEDURE）单独列出 OUT/IN OUT 参数清单 + Mapper CALLABLE 映射。
- **事务边界**（COMMIT/ROLLBACK/PRAGMA AUTONOMOUS_TRANSACTION）标注为事务构造，具体 Java 事务映射见注入的 Java 代码规约 §9.1。
- **异常处理策略**：若 translate-core 产出含 try-catch，在板块 6 记录异常捕获策略（catch 内仅记日志 + 设错误响应 flag/msg，不外抛；no_data_found 用 Validate.notNull 判空）。

## 五、质量要求

- **FSD 自包含**：每个板块写实质内容，**禁止"详见 xxx"占位符**。
- 全程中文输出，专有名词与关键字保持英文。
- refName 用 inventory 算好的（重载带 `__序号`）。

## 六、注释规范（与产物一致）

- 类/方法注释含**生成来源**（存储过程 procedure 或表查询）；字段注释说明对应表字段。
- FSD 中引用的 Java 构造与 translate-core 产出保持一致（只读，不 edit 翻译产物）。

## 七、输出

- FSD 文件：`fsd/{pkg}/{ref}.md`。
- Worker Status：`{artifactsDir}/status/translate.json`（含 shardIndex）。

## 八、硬约束

- 只处理本分片 targetUnits，禁止越界。
- 源码只读 `shard-inputs/{pkg}/{ref}/source.sql`；翻译决策读 per-unit `translations/{pkg}/{ref}.json`（不是聚合 translation.json）。
- 不改翻译产物（只读 Java/decisions，不 edit）。
- 禁止调用 workflow 工具的任何 action。

完成后输出 `WORKER_SUMMARY` + `TASK_STATUS`。
