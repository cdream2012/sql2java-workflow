# Project Spec — skeleton 子阶段（文件创建 + 骨架桩）

> 本规约由引擎注入 translate-skeleton 子 agent 系统提示词。融合自《文件创建规约》《待办逻辑填充文件创建规约_检查后》《详细设计检查规约》（命名/包路径部分），已适配本工作流的 artifact 路径与 per-proc 架构。原 ai-agent/skills/* 调用与设计文档路径已删除/映射。

## 一、核心目标

为本分片单个过程函数（unit）创建**未实现的 per-proc Java 文件**（一过程一组独立类文件）+ 方法签名桩 + `// TODO: [translate]` 占位。桩必须可被 javac parse 通过。**不翻译方法体**（translate-core 子阶段的事）。

## 二、只增不删不覆盖（硬不变量）

1. **创建前必须检查文件是否存在**：用 `read` 工具检查目标路径是否已有文件。
2. **已存在文件只能追加，严禁覆盖/删除/修改原有内容**——旧程序可能被其他逻辑依赖，覆盖会导致运行失败。
3. per-proc 架构下各 unit 独占文件、互不共享，通常直接 `write` 新文件；但仍须先确认路径无同名文件，有冲突时**新建独立 per-proc 文件**而非覆盖既有文件。
4. 禁止用 `write` 覆盖已存在文件——已存在文件用 `edit` 增量追加。

## 三、命名规范

1. **去除 SQL 前缀**：禁止保留 `f_`/`r_`/`sp_` 等 SQL 函数/存储过程前缀。
2. **PascalCase** 大驼峰命名，文件名清晰表达业务功能。
3. **类型后缀**：必须含相应类型后缀（Service/ServiceImpl/Request/Response/Mapper/DO 等）。
4. **类名派生**：`{ProcPascal}{RoleSuffix}`（`ProcPascal` = 本过程名转 PascalCase；`RoleSuffix` 按 Java 代码规约 §4.1 命名约定由 role 派生）。**禁止自行编造类名**——查 `{artifactsDir}/scaffold.json` 的 `packageMappings`（本 unit 所属 `plsqlPackage` → 映射的 `components[]` 角色集）。
5. **命名冲突检查**：同目录不得已有同名文件；不得与相似名混淆；文件名/路径层不得用 Java 关键字（`import`/`package`/`class` 等）。

## 四、包路径规范

| 分类 | 路径（相对 projectRoot） |
|---|---|
| Service 接口 | `src/main/java/.../service/` |
| ServiceImpl | `src/main/java/.../service/impl/` |
| Request | `src/main/java/.../service/dto/request/` |
| Response | `src/main/java/.../service/dto/response/` |
| 工具类 | `src/main/java/.../util/` |
| Mapper 接口 | `src/main/java/.../infra/mapper/` |
| Mapper XML | `src/main/resources/.../infra/mapper/`（或 `mapper/{schema}/{pkg}/`） |
| DO 实体类 | `src/main/java/.../infra/mapper/dataobject/` |

- 实际 javaPackage 由 `scaffold.json.packageMappings` 给出，文件位置 = `{projectRoot}/src/main/java/{javaPackage 以 / 分隔}/{ProcPascal}{RoleSuffix}.java`。
- ❌ 路径层禁含 `import`/`package`/`class` 关键字、空格、中文、特殊符号。
- Mapper XML：`{projectRoot}/src/main/resources/mapper/{schema}/{pkg}/{ProcPascal}Mapper.xml`，namespace = `{javaPackage}.{ProcPascal}Mapper`。

## 五、DO 实体类

- scaffold 阶段已生成全局 DO 实体类，skeleton **只读引用**，不重建、不修改、不覆盖。
- DO 字段必须与 inventory/schema 定义一致，**禁止编造字段**；发现不一致标 `// TODO: [translate]` 交下游，不在 skeleton 改 DO。
- 单表查询 DO 复用 scaffold 全局 DO；联表/计算字段 DO（自定义 DO）由 translate-core 设计，skeleton 不提前建。

## 六、方法签名桩

- 入参/出参类型从 SQL 切片（`shard-inputs/{pkg}/{ref}/source.sql`）+ 依赖签名块推导；不确定的参数类型标 `// TODO: [translate]`。
- Mapper 接口方法签名对应本过程将用到的 SQL 语句（SQL 体由 translate-core 填）。
- 桩体：`return null;` / `return 0;` / `return false;` 等默认值 + `// TODO: [translate] 标记人 标记时间 中文说明原因`，保证可编译。

## 七、包级常量/变量

- scaffold 已生成 per-package `{Pkg}State` 持有类（Java 代码规约 §3.4）。skeleton **只读引用**（业务实现类注入该 holder），不重建、不修改。

## 八、注释规范

- 类注释、方法注释含**生成来源**（如 `生成来源：存储过程 procedure: {schema}.{pkg}.{procName}`）。
- 字段注释说明对应表字段含义。
- 全部中文注释，专有名词与关键字保持英文。

## 九、自检清单

- [ ] 对照 scaffold packageMappings，本 unit 各角色 per-proc 文件均已创建，路径与 javaPackage 一致
- [ ] 无遗漏、无增加（除角色集模板外不擅自加文件）
- [ ] 未覆盖/删除/修改任何已存在文件
- [ ] 桩体可被 javac parse 通过
- [ ] 类名按 `{ProcPascal}{RoleSuffix}` 派生，无命名冲突、无 Java 关键字路径
- [ ] 注释含生成来源
- [ ] DO 只引用未重建；Mapper XML namespace 正确
