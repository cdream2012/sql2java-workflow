# sql2java-workflow

基于 AI Agent 的 PL/SQL → Spring Boot + MyBatis 端到端转译系统。确定性状态机驱动的单流水线工作流，以严格 1:1 忠实转换为原则，将 PL/SQL 翻译为可编译的 Java 应用。

## 架构概览

```
/sql2java <path>
  │
  ▼
.opencode/command/sql2java.md        参数解析 → 路由 → workflow 工具调用
  │
  ▼
Schema 预获取（可选，有 db.properties 时触发）→ ddl-output/
  │
  ▼
inventory → scaffold → translate → dedup → review → verify → 完成
                              ↑       │             │            │
                              │       │             ↓ (failed)   ↓ (failed)
                              │       │             fix ←────────┘
                              └───────┘             └→ fix → review（增量回环）
```

**单流水线**：6 阶段 + 1 条件分支（fix），一个 runId，无条件前进；review/verify 失败进 fix 循环（增量重做），fix 完成回到 review。dedup 只在主线 translate 后跑一次。analyze/plan 阶段已先后合并（analyze 砍、plan 合并入 scaffold）。

## 命令用法

支持**自然语言**或 **CLI flag**，解析器先提 flag 再对剩余文本做字段抽取，必填字段（源码目录）抽不全会追问。

### 自然语言（推荐）

```
# 整个项目全量翻译
/sql2java 帮我把 /path/sql 下的存储过程转成 java

# 只译入口过程及其调用闭包（过程级 mainEntry，含点标识符原样捕获）
/sql2java 请帮我把 /path/to/project 下的 schema.package.proc 转为 java
/sql2java 帮我把 resources/MFG_ERP 的存储过程转成 java，入口为 MFG_ERP.F_BOM.explode

# 状态 / 续传
/sql2java 看下状态
/sql2java 继续上次
```

> "把 `<path>` 下的 `<含点标识符>` 转为 java" 这类**翻译目标句式**会把含点标识符（如 `schema.package.proc`）原样归为过程级 `mainEntry`，引擎按最后一个 `.` 切分包名与 refName，触发闭包 scope。

### CLI flag（兼容老语法）

```
/sql2java <path>                                          # 端到端全流程（单目录，默认）
/sql2java --db_conf db.properties <path>                  # 指定数据库配置
/sql2java --spec project-spec.md <path>                   # 指定自定义代码规约
/sql2java --mainEntry pkg/CORE_PKG.bulk_receive <path>    # 过程级入口：只译入口闭包；纯包名=全量
/sql2java --dedupRules dedup-rules.json <path>            # dedup 排除/强制复用规则
/sql2java --header <h> --body <b>                         # 双目录兜底（仅当包头/包体在无共同父目录的两棵树）
/sql2java --phases scaffold,translate <path>              # 指定阶段执行
/sql2java status | resume                                 # 状态 / 续传
```

### 源码目录模式

| 模式 | 形式 | 说明 |
|------|------|------|
| **单目录（推荐，默认）** | 位置 `<path>` | scanner 递归扫 `.sql/.pks/.pkb/.pls`，按 `PACKAGE` vs `PACKAGE BODY` 内容区分 spec/body，按包名配对填 `headerLocation`/`bodyLocation`。`headerPath`/`bodyPath` 留 null。包头/包体同根时用此模式 |
| **双目录（兜底）** | `--header <h> --body <b>` | 仅当包头与包体分散在**无共同父目录的两棵树**时用。两者作独立 root 递归遍历（按绝对路径去重），保 header-first |
| **三路径（罕见）** | `<path>` + `--header` + `--body` | 包头/包体分目录且非包 DDL（type/schema）又在另一处时用；`<path>` 父目录补 type/schema，`--header`/`--body` 保配对 |

### 过程级入口闭包翻译（mainEntry）

- **过程级** `[subdir/]PKG.refName`（如 `pkg/CORE_PKG.bulk_receive`、`schema.package.proc`）：触发**闭包 scope 模式**——只译该入口及其直接/间接调用的全部子程序，跨子目录、跨包自动收拢。`<package>` 可含任意多段点（schema/dotted 子路径），引擎按最后一个 `.` 切分；重载入口须显式写 refName（如 `PKG.get_param__2`）。
- **包级**（纯包名）/ 缺省：全量翻译整个项目。

闭包由 `workflow/scope-computer.ts` 纯函数计算（零 LLM）：`scopeUnits` = 沿 callGraph 正向 BFS 的被调用子程序；`scopePackages` = 其所属包 ∪ 沿 packageDependency 到达的包（仅常量/类型被引用的包进 scopePackages 出壳，不译过程体）。各阶段按 scope 收敛。入口不可解析（拼写错/子程序不存在/subdir 不匹配）→ inventory advance **硬失败**，不静默回退全量。

## 工作流阶段

| 阶段 | Agent | 重试 | 说明 |
|------|-------|------|------|
| inventory | sql-analyst | 2 | 确定性 regex 预扫描（零 LLM）+ per-package 编目 + 依赖图 |
| scaffold | java-architect | 1 | targetProject + packageMappings 决策 + Spring Boot 骨架 + Entity/Mapper/常量持有类（DDD 行为层壳由 translate-skeleton 建） |
| translate | translator | 3 | 按拓扑序逐包翻译（按包分片，SCC 组共处） |
| dedup | java-architect | 2 | 跨包重复检测 + 公共模块抽取 |
| review | reviewer | 1 | 静态扫描 + LLM 语义审查 |
| verify | reviewer | 2 | mvn compile + MyBatis 校验 + 测试 |
| fix | translator | 5 | 修复 mustFix 项，完成后回到 review |

- **分片**：translate 按包分片（`maxPackagesPerShard=1`），基于 Tarjan SCC 拓扑序；translate 保留 SCC 组共处（互依赖包同 session 拿对方签名），分片上游 artifact 收窄到本包。
- **fix 循环**：review/verify failed → fix → review；双层 exhausted 策略（globalMax=5 / phaseMax=5），达限 → `completed_with_issues`。
- **质量门控**：翻译完成率 ≥0.8、review 分数 ≥70、测试通过率 ≥0.7。

## 运行环境要求

| 依赖 | 最低版本 | 说明 |
|------|---------|------|
| Node.js | 18+ | 运行 opencode 插件 + vitest（`ensure-deps` 自动 npm/bun 装 `.opencode/node_modules`） |
| JDK | 8（1.8） | 生成项目目标 Java 8；maven-pmd-plugin 3.21.2 + PMD 6.55.0 最低 JDK 8 |
| Apache Maven | 3.5+ | Spring Boot 2.7 要求；首次运行自动下载缓存 `~/.m2` |

dedup dispatch 前校验 `mvn --version`，JDK < 8 或 Maven < 3.5 → 优雅跳过 dedup（写占位 `dedup.json`）；verify 若 mvn/JDK 缺失亦跳过编译。mvn + jar 跨平台（Win/Linux/macOS）。

## 后台运行长程任务

```bash
# 方案一：nohup 后台直接运行
nohup opencode run "/sql2java /path/to/plsql" \
  --dangerously-skip-permissions --format json \
  -m zai-coding-plan/glm-5.1 > sql2java-output.json 2>&1 &

# 方案二：headless 服务 + 挂载
opencode serve --port 4096 &
opencode run "/sql2java /path/to/plsql" --attach http://localhost:4096 \
  --dangerously-skip-permissions --format json -m zai-coding-plan/glm-5.1

# 方案三：中断后续传
nohup opencode run "/sql2java resume" --dangerously-skip-permissions --format json \
  -m zai-coding-plan/glm-5.1 >> sql2java-output.json 2>&1 &
```

`--dangerously-skip-permissions` 自动批准权限（各阶段 advance 无需人工 confirm）；`resume` 在上下文溢出/中断后断点续传。`opencode models` 查可用模型。

## Artifact 存储

```
.workflow-artifacts/{runId}/
├── run.json                  # WorkflowRun 持久化（引擎状态）
├── run-context.json          # 输入参数 + 目录稳固快照（start 写一次，resume 兜底）
├── inventory.json            # 索引 + DDL 数据
├── inventory-packages/       # 逐包 inventory（LLM enriched）
├── analysis-packages/        # 逐包子程序结构
├── dependency-graph.json     # callGraph + topology + complexity
├── scaffold.json / dedup.json / fix.json   # scaffold.json 含 targetProject + packageMappings（原 plan.json 已合并）
├── fsd/{package}/{subprogram}.md        # FSD 文档（translate 末尾 fsd sub-stage 产物）
├── translations/{package}/              # translation.json / review.json / verify.json
├── review-summary.json / verify-summary.json
└── logs/                    # workflow.log / watchdog.log / _events.log
```

`db.properties` 存在时，Schema 预获取产物落在 `{sourcePath}/ddl-output/`（tables/triggers/views/sequences/types）。

## PL/SQL 预扫描器

`.opencode/workflow/plsql-scanner.ts` 在 inventory 阶段确定性扫描（零 LLM），不占上下文窗口。

| 路径 | 实现 | 状态 |
|------|------|------|
| **Regex 主路径** | `scanFileSetRegex`（状态机 + 正则 + 行号追踪，`plsql-file-scanner.ts`） | **生产启用** |
| AST 路径 | `antlr4ts` + 官方 PL/SQL grammar | 保留不启用，仅作回归对照 |

按文件**内容**判定 spec（`CREATE PACKAGE`）/ body（`CREATE PACKAGE BODY`），与扩展名/目录无关，全 `.sql` 项目也能正确识别。提取：包 spec/body 结构 + 子程序签名 + 包级 types/variables/constants + DDL 对象 + 调用关系图 + standalone 过程（注入 `__STANDALONE_{NAME}__` 虚拟包）。`inventory-index.json` 经内存 cache 交接，不落盘。

## Schema 预获取

`schema-fetcher.ts` 启动前执行，发现 `db.properties`（`--db_conf` 或 `{sourcePath}/db.properties`）时连 PostgreSQL/GaussDB 拉取表/触发器/视图/序列/对象类型到 `{sourcePath}/ddl-output/`。pg 驱动为 optionalDependencies（离线/内网开箱即用）。无配置则跳过（DDL-only 模式）。密码可 `env:VAR_NAME` 引用，连接用户只需 SELECT 权限。

## Java 代码规约

`.opencode/docs/java-code-spec.md` 统一规约自动注入 java-architect / translator / reviewer 三个 agent（命名/格式/OOP/集合异常/中文注释/ORM 映射/工程结构）。违反【强制】→ major/critical，出现英文注释标记为 major。`--spec <file>` 按 `##` 章节覆盖同名章节、独有章节追加，`## 工程结构` 章节自动提取目录结构；文件发现优先级：`--spec` → `<sourcePath>/project-spec.md`。

## 技术栈

- **运行框架**：[opencode](https://opencode.ai) AI Agent 插件（`@opencode-ai/plugin`）
- **Workflow Engine**：TypeScript 确定性状态机
- **SQL 解析**：regex 主路径（`scanFileSetRegex`）+ AST 保留对照 + LLM 语义补充
- **Schema 获取**：pg 驱动（可选，PostgreSQL/GaussDB）
- **Schema 校验**：Zod
- **Agent 定义**：Markdown（`.opencode/agent/`，按 `## Phase: xxx` 分节）
- **目标框架**：Spring Boot + MyBatis + Lombok + Maven

## 输入输出

- **输入**：一组 PL/SQL 文件（`.sql/.pks/.pkb/.pls`），单目录（推荐）/ `--header`+`--body` 双目录兜底 / 三路径。参见 `resources/MFG_ERP/`（分目录：`PACKAGE/` 包头 + `PACKAGE_BODY/` 包体）。
- **输出**：可编译的 Java 项目（Spring Boot + MyBatis + Lombok）+ 转译过程 artifacts。
