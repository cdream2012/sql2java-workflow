# Java 代码规约

> 此规约由工作流引擎自动注入到写 Java 的 agent（java-architect / translator / reviewer / translate-skeleton / translate-core / translate-test）的 system prompt 中。
> 修改此文件即可全局生效，无需同步修改多个 agent 文件。
> 用户可通过 `--spec` 参数提供自定义规约文件——指定后**整体替换**本默认规约（用户文件即唯一规约，不再与默认合并）；纯目录结构文件仅覆盖工程结构，规约仍用本默认。

## 适用范围

适用于 PL/SQL 存储过程 → 基于 **4 文件分层架构**（Entity/Mapper/Service/ServiceImpl）的 Spring Boot + MyBatis 工程翻译场景。规约主体为分层架构与存储过程→Java 组件映射规约；版本与框架配置见末尾【强制】段落。

> **结构模型由本规约驱动（架构无关 workflow）**：分层架构、组件角色、层路径、入口角色、测试目标、非业务目录一律以本规约 §一/§二/§工程结构/§3.2/§十四 为准——workflow 引擎与 agent 提示词不写死任何具体模型，scaffold 据本规约填 `packageMappings.components[]` 与 `coverageExcludes`，translate/review/verify 据此建壳/翻译/审查/归因。用户 `--spec` 整体替换本规约即可切换架构模型（如换 DDD 规约则按 DDD 跑）。

> **无根包模型**：本规约采用「无根包 + 按角色分层」布局——分层目录（mapper/service/service.impl/constant/dto/entity/exception/util/config）直接作为顶层 Java package，不再有项目根包（packageBase），也不按 PL/SQL schema/package 分子目录。过程/函数按角色落对应顶层包，包级常量/变量分别落 `constant/` 与 `dto/`。`@SpringBootApplication` 主类放 `config/`，靠显式 `scanBasePackages` 扫描各兄弟层包。

> **工程结构章节**：下方 `## 工程结构` 为**无根包扁平分层**目录布局模板——过程/函数映射为按角色落位的 per-proc 类（一文件一类，文件名=过程名 PascalCase，跨包同名碰撞加数字后缀），包级常量/变量映射为 per-package 的 `{Pkg}Constant`/`{Pkg}StateDTO`。该章节正文仅含可解析路径（行内 `#` 注释由引擎剥离），供 `--spec` 结构提取与 scaffold 消费。

## 工程结构

src/main/java/config                            # Spring/MyBatis 配置 + Application 主类（全局）
src/main/java/mapper                            # per-proc Mapper 接口（{Proc}Mapper.java）
src/main/java/service                           # per-proc Service 接口（{Proc}Service.java）
src/main/java/service/impl                      # per-proc Service 实现（{Proc}ServiceImpl.java）
src/main/java/constant                          # per-package 包级常量类（{Pkg}Constant.java，纯 static final）
src/main/java/dto                               # per-package 包级变量 DTO（{Pkg}StateDTO.java，可变实例字段）
src/main/java/entity                            # 数据对象 XxxDO（与数据库表一一对应，全局共享，scaffold 生成）
src/main/java/exception                         # 业务异常体系 BusinessException 等（全局）
src/main/java/util                              # 通用工具类（全局）
src/main/resources/mapper                       # per-proc Mapper XML（{Proc}Mapper.xml，扁平）
src/test/java/service/impl                      # per-proc ServiceImpl 测试（{Proc}ServiceImplTest.java）
src/test/java/mapper                            # per-proc Mapper 集成测试（{Proc}MapperIntegrationTest.java）
src/test/resources                              # schema-h2.sql + application-test.yml

## 一、分层架构规范

### 1.1 分层职责

| 层级 | 目录 | 职责 | 对应存储过程概念 |
|------|------|------|------------------|
| **Entity** | `entity`（全局） | 数据对象（XxxDO），与数据库表字段一一对应 | 表/%ROWTYPE |
| **Mapper** | `mapper`（per-proc） | MyBatis 接口，SQL 执行 | DML/查询 |
| **Service** | `service`（per-proc） | 业务接口，对外暴露公共方法 | 存储过程入口/包规范 |
| **ServiceImpl** | `service.impl`（per-proc） | 业务实现，流程编排 + 事务 + 异常 | 主存储过程调用链 |
| **DTO** | `dto`（per-package，按需） | 包级变量 DTO `{Pkg}StateDTO`；过程参数 DTO 亦落此 | 包级变量/过程参数 |
| **Exception** | `exception`（全局） | 业务异常体系 | EXCEPTION 块 |
| **Constant** | `constant`（per-package） | 包级常量持有类 `{Pkg}Constant`（纯 static final） | 包级常量 |
| **Util** | `util`（全局） | 通用工具方法 | 公共函数库 |
| **Config** | `config`（全局） | Application 主类 + Spring/MyBatis 配置 | — |

> **映射粒度**：每个过程/函数 → 按角色落顶层包的一组 per-proc 类（一文件一类，类名 `{ResolvedBase}{Role}`，如 `CreateOrderService`/`CreateOrderServiceImpl`/`CreateOrderMapper`）。`{ResolvedBase}` = 过程名转 PascalCase，**跨包同名碰撞时由 scaffold 全局去重加数字后缀**（首现 `CreateOrder`，后续 `CreateOrder2`/`CreateOrder3`，见 §4.1）；去重映射记入 `scaffold.json.generated.procClassNames`，translate 据此派生类名/文件名。包级常量 → per-package `constant/{Pkg}Constant`；包级变量 → per-package `dto/{Pkg}StateDTO`。全局共享件（Entity/Exception/Util/Config）单列全局顶层包。下方代码示例中的 `Xxx`/`Order` 仅为命名演示，实际按 per-proc `{ResolvedBase}` 命名。

**规约要点：**
1. 【强制】每个过程/函数映射为一组 per-proc 角色（默认 `Service` + `ServiceImpl` + `Mapper`，本规约可调），按角色落对应顶层包（`service`/`service.impl`/`mapper`）。Service 暴露该过程公共方法、ServiceImpl 实现业务逻辑。
2. 【强制】Service 接口只声明方法签名，不含逻辑；所有业务逻辑在 ServiceImpl。
3. 【强制】ServiceImpl 通过**构造器注入** Mapper（与 Lombok `@RequiredArgsConstructor` 配合），禁止字段注入。
4. 【强制】跨包调用经被调方 **Service 接口**注入，不得直接引用他包 Mapper。
5. 【强制】主存储过程含多个子流程（子程序调用 / 顺序逻辑段 / 跨包调用）时，ServiceImpl 按原 PL/SQL 调用顺序编排，体现"主存储过程调用链"。步骤单一的主存储过程保持单方法，不强拆。拆分依据是原 SP 的调用结构（调用语句边界），属忠实呈现而非重构，不违反"不重构"原则。

## 二、ServiceImpl 实现模式

ServiceImpl 是业务实现的核心，负责流程编排、事务、异常处理。

```java
@Service
@Slf4j
@RequiredArgsConstructor
public class XxxServiceImpl implements XxxService {

    private final XxxMapper xxxMapper;

    @Override
    public void processXxx(XxxDO xxx) {
        log.info("processXxx start, key={}", xxx.getId());
        // 业务逻辑：参数校验 + Mapper 调用 + 状态流转
        xxxMapper.save(xxx);
    }

    @Override
    public XxxDO queryXxx(Long id) {
        XxxDO result = xxxMapper.selectById(id);
        if (result == null) {
            throw new DataNotFoundException("数据不存在, id=" + id);
        }
        return result;
    }
}
```

**规约要点：**
1. 【强制】ServiceImpl 标注 `@Service`，实现对应 Service 接口。
2. 【强制】依赖用 `@RequiredArgsConstructor` + `final` 字段构造器注入（Lombok 生成构造器），禁止 `@Autowired` 字段注入。
3. 【强制】类上标注 `@Slf4j`，直接用 `log.info(...)`/`log.error(msg, e)` 记录日志，禁止手写 `LoggerFactory.getLogger`。
4. 【强制】写操作方法标注 `@Transactional(rollbackFor = Exception.class)`；Service 接口方法不标事务。
5. 【强制】所有覆写方法标 `@Override`。

## 三、存储过程转换映射规则

### 3.1 PL/SQL → Java 类型映射

scaffold 生成 XxxDO 字段、translate 转译过程参数/返回值时，**统一按下表**将 PL/SQL 类型映射为 Java 类型（本表是唯一事实来源）：

| PL/SQL 类型 | Java 类型 | 说明 |
|-------------|-----------|------|
| `VARCHAR2` / `VARCHAR` / `CHAR` / `NCHAR` / `NVARCHAR2` / `CLOB` / `LONG` | `String` | 字符串/大文本 |
| `NUMBER`（整数，scale=0） | `Long` | 大整数用 Long 防溢出；确定小范围可 `Integer` |
| `NUMBER`（小数，scale>0） | `BigDecimal` | 金额/计量必须 BigDecimal，禁用 double/float |
| `NUMBER`（未定 precision/scale） | `BigDecimal` | 不确定时统一 BigDecimal |
| `INTEGER` / `INT` / `SMALLINT` / `BINARY_INTEGER` / `PLS_INTEGER` | `Integer` 或 `Long` | 按取值范围 |
| `FLOAT` / `BINARY_FLOAT` / `BINARY_DOUBLE` | `Double` | |
| `DATE` | `LocalDate` | 仅日期 |
| `TIMESTAMP` / `TIMESTAMP(6)` | `LocalDateTime` | 日期时间 |
| `TIMESTAMP WITH TIME ZONE` | `OffsetDateTime` | |
| `BOOLEAN` | `Boolean` | 包装类型 |
| `BLOB` / `RAW` / `LONG RAW` | `byte[]` | 二进制 |
| `XMLTYPE` | `String` | XML 文本 |
| 用户定义对象类型 / `OBJECT` | 对应 DO 实体类 | 见下 `%ROWTYPE`/`%TYPE` |
| 集合类型 / `TABLE` / `VARRAY` | `List<元素类型>` | |

**`%ROWTYPE` 与 `%TYPE` 处理**：
- `table%ROWTYPE` 参数 → 使用对应表的 DO 实体类（如 `gmo_clr_settle%ROWTYPE` → `GmoClrSettleDO`）作为属性类型。
- `table.column%TYPE` 参数 → 取该列对应 DO 字段的实际 Java 类型（按上表由列的 PL/SQL 类型推导），不得降级为 `String`。
- 同一表中多个 `%TYPE` 引用复用同一 DO/类型，不重复定义。

> POJO（DO/DTO）属性一律用**包装类型**（Long/Integer/BigDecimal/Boolean…），不设默认值；局部变量可用基本类型。

### 3.2 存储过程 → Java 组件映射

> per-proc 粒度：每个 `PROCEDURE`/`FUNCTION` 落为按角色分顶层包的一组独立类，类名 `{ResolvedBase}{Role}`（`ResolvedBase` = 过程名转 PascalCase，跨包同名碰撞加数字后缀，见 §4.1；无碰撞时即 `{ProcPascal}`）。

| 存储过程元素 | Java 对应组件 | 说明 |
|-------------|---------------|------|
| `PROCEDURE/FUNCTION` 入口 | `{Proc}Service` + `{Proc}ServiceImpl` | per-proc 对外接口（`service/`）+ 实现（`service.impl/`） |
| 主流程/业务逻辑 | `{Proc}ServiceImpl` | 编排 + 事务 + 异常 |
| 变量声明/初始化 | `{Proc}ServiceImpl` 方法内局部变量 | 默认值填充（局部变量） |
| 包级常量 | `{Pkg}Constant` 常量类 | per-package，`constant/`，见 §3.4 |
| 包级变量 | `{Pkg}StateDTO` | per-package，`dto/`，见 §3.5 |
| 参数组装 | `{Proc}DTO` / `Map<String,Object>` | per-proc 参数构建（DTO 落 `dto/`） |
| IF-THEN-ELSE 校验 | `{Proc}ServiceImpl` 内校验 + 抛 `ValidationException` | 业务校验 |
| 跨包调用 | 被调方 `{Proc}Service` 接口 | 外部服务（按 `service.{ResolvedBase}Service` 派生） |
| 公共函数 | `Util` | 全局工具类 |
| `COMMIT/ROLLBACK` | `@Transactional` | 事务管理 |
| DML/查询/存储过程调用 | `{Proc}Mapper` + `{Proc}Mapper.xml` | per-proc Mapper（`mapper/` + `resources/mapper/`） |

### 3.3 异常处理规范

```java
// ServiceImpl 内：校验失败抛 ValidationException，数据缺失抛 DataNotFoundException
if (xxx == null || xxx.getId() == null) {
    throw new ValidationException("参数不能为空");
}
XxxDO exist = xxxMapper.selectById(xxx.getId());
if (exist == null) {
    throw new DataNotFoundException("数据不存在, id=" + xxx.getId());
}

// 业务异常统一用 BusinessException 体系，try-catch 包装重抛
try {
    xxxMapper.save(xxx);
} catch (Exception e) {
    log.error("保存失败, key={}", xxx.getId(), e);
    throw new BusinessException("保存失败: " + e.getMessage(), e);
}
```

**规约要点：**
1. 【强制】业务异常统一使用 `exception` 包下的 `BusinessException` 体系（`BusinessException` 基类 + `DataNotFoundException` + `ValidationException`），禁止抛出 `new RuntimeException()`、`Exception` 或 `Throwable`。
2. 【强制】`BusinessException` 为 **unchecked**（继承 `RuntimeException`），方法签名无需 `throws` 声明。
3. 【强制】catch 块不得丢弃原始异常信息：必须包装重抛（`throw new BusinessException(msg, e)`）或经 `log.error(msg, e)` 记录完整堆栈；禁止空 catch、禁止仅打印 `e.getMessage()` 丢弃堆栈。
4. 【强制】校验失败抛 `ValidationException`；数据不存在抛 `DataNotFoundException`；其他业务错误抛 `BusinessException`。

### 3.4 包级常量映射（`{Pkg}Constant` 常量类）

PL/SQL 包级常量（package spec/body 顶层声明的 `constants`）集中映射到 per-package 的 `{Pkg}Constant` 常量类，由 **scaffold** 从 inventory `packages/{pkg}.json` 的 `constants` 一次性生成完整字段，translate 只读引用、不修改该类。位于 `constant/{Pkg}Constant.java`。

```java
// per-package 常量类（scaffold 生成，位于 constant/{Pkg}Constant.java）
public final class FOrderConstant {
    private FOrderConstant() { }
    public static final String DEFAULT_STATUS = "ACTIVE";
    public static final Integer MAX_RETRY = 3;
}
```

**规约要点：**
1. 【强制】包级常量（inventory `constants`）→ `public static final` 字段，类型按 §3.1。
2. 【强制】常量类为 `public final class` + 私有构造函数，纯 `static final` 字段，不可实例化。
3. 【强制】`{Proc}ServiceImpl` 引用包常量 → 直接用 `{Pkg}Constant.字段名` 静态访问；不得在 per-proc 类内重新声明包级常量。
4. 【强制】scaffold 生成时常量名/值/类型保真，PL/SQL 类型→Java 类型按 §3.1，跨包引用对齐。

### 3.5 包级变量映射（`{Pkg}StateDTO` 变量 DTO）

PL/SQL 包级可变变量（package spec/body 顶层声明的 `variables`）映射到 per-package 的 `{Pkg}StateDTO`，由 **scaffold** 从 inventory `packages/{pkg}.json` 的 `variables` 生成，translate 只读引用、不修改该类。位于 `dto/{Pkg}StateDTO.java`。仅有变量的包才生成；无变量的包不生成。

```java
// per-package 变量 DTO（scaffold 生成，位于 dto/{Pkg}StateDTO.java）
@Component
@Scope("session")  // 可变包变量按 session 作用域，贴 PL/SQL session 级语义
public class FOrderStateDTO {
    // 包级可变变量：实例字段 + getter/setter（session 作用域 bean，每会话独立）
    private Long cursorPos;
    private BigDecimal runningTotal;

    public Long getCursorPos() { return cursorPos; }
    public void setCursorPos(Long cursorPos) { this.cursorPos = cursorPos; }
    public BigDecimal getRunningTotal() { return runningTotal; }
    public void setRunningTotal(BigDecimal runningTotal) { this.runningTotal = runningTotal; }
}
```

**规约要点：**
1. 【强制】包级可变变量（inventory `variables`）→ session 作用域 bean 的实例字段 + getter/setter（`@Scope("session")`），不得用 `static` 可变字段（线程不安全）。
2. 【强制】`{Proc}ServiceImpl` 读写包变量 → 注入 `{Pkg}StateDTO` bean，经 getter/setter 访问；不得在 per-proc 类内重新声明包级变量。
3. 【强制】scaffold 生成时 PL/SQL 类型→Java 类型按 §3.1，变量 `defaultValue` 转为字段初始化或构造器默认。
4. 【推荐】真正使用可变包状态且语义敏感的过程，review 阶段打 package-state flag 人工复核（session 作用域在非 web 上下文需确认可用性）。

## 四、编码规范

### 4.1 命名规范

| 类型 | 命名规则 | 示例 |
|------|----------|------|
| Entity（数据对象） | `{Table}DO` | `OrderDO` |
| 过程参数 DTO | `{Proc}DTO` | `CreateOrderDTO` |
| 包级变量 DTO | `{Pkg}StateDTO` | `FOrderStateDTO` |
| Mapper 接口 | `{Proc}Mapper` | `CreateOrderMapper` |
| Service 接口 | `{Proc}Service` | `CreateOrderService` |
| Service 实现 | `{Proc}ServiceImpl` | `CreateOrderServiceImpl` |
| 异常类 | `XxxException` | `BusinessException` |
| 包级常量类 | `{Pkg}Constant` | `FOrderConstant` |
| 工具类 | `XxxUtil` | `StringUtil` |
| 测试类 | `{Proc}ServiceImplTest` / `{Proc}MapperIntegrationTest` | `CreateOrderServiceImplTest` |

> `{Proc}` = 过程/函数名转 PascalCase（下划线分段首字母大写，如 `CREATE_ORDER` → `CreateOrder`）；**跨包同名过程碰撞时由 scaffold 全局去重，首现保持 `{ProcPascal}`，后续加数字后缀 `{ProcPascal}2`/`{ProcPascal}3`**（去重后基名记为 `{ResolvedBase}`，落 `scaffold.json.generated.procClassNames`）；`{Pkg}` = PL/SQL 包名转 PascalCase；`{Table}` = 表名转 PascalCase。Java 顶层包段全小写（`service.impl`）。

**规约要点：**
1. 【强制】类名 UpperCamelCase；方法名、参数名、成员变量、局部变量 lowerCamelCase；常量全大写下划线分隔；包名全小写。
2. 【强制】数据对象（与数据库表一一对应）统一使用 `{Table}DO` 后缀；跨层数据传输用 `{Proc}DTO` 后缀；禁止 `XxxPOJO`。
3. 【强制】POJO 类布尔属性不加 `is` 前缀；数据库布尔字段必须加 `is_`，在 resultMap 中映射。
4. 【强制】命名不得以下划线或美元符号开始或结束；严禁拼音与英文混合，禁止直接使用中文。
5. 【强制】抽象类用 `Abstract`/`Base` 开头；异常类用 `Exception` 结尾；测试类以被测类名开头、`Test` 结尾。
6. 【推荐】Service/DAO 层方法前缀：`get` 取单个、`list` 取多个、`count` 取统计、`save/insert` 插入、`remove/delete` 删除、`update` 修改。
7. 【强制】per-proc 类按角色落对应顶层包（`service`/`service.impl`/`mapper`），一文件一 public 类；类名由过程名派生（`{ResolvedBase}{Role}`），禁止用 PL/SQL 包名做类名前缀拼接所有过程。per-package 的 `{Pkg}Constant` 落 `constant/`、`{Pkg}StateDTO` 落 `dto/`。

### 4.2 注释规范

```java
/**
 * 订单业务实现
 * <p>负责订单导入流程，协调 Mapper 完成订单校验、存储等步骤</p>
 * <p>主要处理流程：</p>
 * <ol>
 *     <li>校验订单参数</li>
 *     <li>构建查询参数获取交易列表</li>
 *     <li>遍历交易列表逐个处理</li>
 * </ol>
 * @author sql2java-workflow
 * @version 1.0
 * @since 2026-07-21
 */
@Service
@Slf4j
@RequiredArgsConstructor
public class OrderServiceImpl implements OrderService {
```

**规约要点：**
1. 【强制】所有注释必须使用中文（Javadoc、行内注释、TODO 标记等），专有名词（Spring、MyBatis、Mapper 等）与 Java 关键字保持英文原文。
2. 【强制】类、类属性、类方法的注释使用 Javadoc 规范（`/** 内容 */`），不得使用 `// xxx`。
3. 【强制】类注释必须包含：职责描述、主要流程、`@author`、`@version`、`@since`。
4. 【强制】方法注释必须包含：功能描述、参数说明、返回值、异常说明。
5. 【推荐】复杂逻辑使用 `<ol>`/`<ul>` 列表说明步骤。

### 4.3 日志规范

```java
@Slf4j
@RequiredArgsConstructor
public class OrderServiceImpl implements OrderService {
    // Lombok @Slf4j 自动生成 private static final Logger log;

    public void processOrder(OrderDO order) {
        log.info("processOrder start, orderId={}", order.getId());
        try {
            // 业务逻辑
        } catch (Exception e) {
            log.error("processOrder 失败, orderId={}", order.getId(), e);
            throw new BusinessException("处理失败", e);
        }
    }
}
```

**规约要点：**
1. 【强制】统一使用 Lombok `@Slf4j` 注解 + `log.xxx(...)` 记录日志，禁止直接使用 Log4j/Logback API、禁止手写 `LoggerFactory.getLogger` 声明、禁止自定义日志门面类。
2. 【强制】方法入口/出口建议记录 info 日志；异常必须记录 error 日志并附带完整堆栈（`log.error(msg, e)`）。
3. 【强制】日志占位符使用 `{}`，禁止字符串拼接。
4. 【推荐】批量处理需记录执行耗时。

## 五、代码格式

1. 【强制】如果是大括号内为空，则简洁地写成 {} 即可；非空代码块：左大括号前不换行，左大括号后换行，右大括号前换行，右大括号后有 else 则不换行，终止的右大括号后必须换行。
2. 【强制】左小括号和字符之间不出现空格；右小括号和字符之间也不出现空格；而左大括号前需要空格。
3. 【强制】if/for/while/switch/do 等保留字与括号之间都必须加空格。
4. 【强制】任何二目、三目运算符的左右两边都需要加一个空格。
5. 【强制】采用 4 个空格缩进，禁止使用 tab 字符。
6. 【强制】注释的双斜线与注释内容之间有且仅有一个空格。
7. 【强制】在进行类型强制转换时，右括号与强制转换值之间不需要任何空格隔开。
8. 【强制】单行字符数限制不超过 120 个，超出需要换行，换行时遵循缩进、运算符与下文一起换行、点符号与下文一起换行、逗号后换行、括号前不换行等原则。
9. 【强制】方法参数在定义和传入时，多个参数逗号后边必须加空格。
10. 【强制】IDE 的 text file encoding 设置为 UTF-8；IDE 中文件的换行符使用 Unix 格式，不要使用 Windows 格式。
11. 【推荐】单个方法的总行数不超过 80 行。
12. 【推荐】没有必要增加若干空格来使变量的赋值等号与上一行对应位置的等号对齐。
13. 【推荐】不同逻辑、不同语义、不同业务的代码之间插入一个空行分隔开来以提升可读性。

## 六、OOP 规约

1. 【强制】避免通过一个类的对象引用访问此类的静态变量或静态方法，直接用类名来访问即可。
2. 【强制】所有的覆写方法，必须加 @Override 注解。
3. 【强制】相同参数类型，相同业务含义，才可以使用 Java 的可变参数，避免使用 Object。可变参数必须放置在参数列表的最后。
4. 【强制】外部正在调用或者二方库依赖的接口，不允许修改方法签名，避免对接口调用方产生影响。接口过时必须加 @Deprecated 注解，并清晰地说明采用的新接口或者新服务是什么。
5. 【强制】不能使用过时的类或方法。
6. 【强制】Object 的 equals 方法容易抛空指针异常，应使用常量或确定有值的对象来调用 equals。
7. 【强制】所有整型包装类对象之间值的比较，全部使用 equals 方法比较。
8. 【强制】浮点数之间的等值判断，基本数据类型不能用 == 来比较，包装数据类型不能用 equals 来判断。
9. 【强制】定义数据对象 DO 类时，属性类型要与数据库字段类型相匹配。
10. 【强制】为了防止精度损失，禁止使用构造方法 BigDecimal(double) 的方式把 double 值转化为 BigDecimal 对象。推荐入参为 String 的构造方法，或使用 BigDecimal.valueOf 方法。
11. 【强制】所有的 POJO 类属性必须使用包装数据类型。【强制】RPC 方法的返回值和参数必须使用包装数据类型。【推荐】所有的局部变量使用基本数据类型。
12. 【强制】定义 DO/DTO 等 POJO 类时，不要设定任何属性默认值。
13. 【强制】序列化类新增属性时，请不要修改 serialVersionUID 字段，避免反序列失败；如果完全不兼容升级，则修改 serialVersionUID 值。
14. 【强制】构造方法里面禁止加入任何业务逻辑，如果有初始化逻辑，请放在 init 方法中。
15. 【强制】POJO 类必须写 toString 方法。如果继承了另一个 POJO 类，注意在前面加一下 super.toString。
16. 【强制】禁止在 POJO 类中，同时存在对应属性 xxx 的 isXxx() 和 getXxx() 方法。
17. 【推荐】使用索引访问用 String 的 split 方法得到的数组时，需做最后一个分隔符后有无内容的检查，否则有抛 IndexOutOfBoundsException 的风险。
18. 【推荐】当一个类有多个构造方法，或者多个同名方法，这些方法应该按顺序放置在一起，便于阅读。
19. 【推荐】类内方法定义的顺序依次是：公有方法或保护方法 > 私有方法 > getter / setter 方法。
20. 【推荐】setter 方法中，参数名称与类成员变量名称一致，this.成员名 = 参数名。在 getter/setter 方法中，不要增加业务逻辑。
21. 【推荐】循环体内，字符串的连接方式，使用 StringBuilder 的 append 方法进行扩展。
22. 【推荐】final 可以声明类、成员变量、方法、以及本地变量，用于不允许继承的类、不允许修改引用的域对象、不允许被覆写的方法、不允许运行中重新赋值的局部变量等场景。
23. 【推荐】慎用 Object 的 clone 方法来拷贝对象。
24. 【推荐】类成员与方法访问控制从严——构造方法最小可见、静态工具类私有构造禁止 public、成员变量和方法最小可见原则。（注：`@Service`/`@Component` 注解的类由 Spring 实例化，构造方法保留 public；本条针对静态工具类。）

## 七、集合处理

1. 【强制】只要覆写 equals，就必须覆写 hashCode。Set 存储的对象必须覆写这两个方法。自定义对象作为 Map 的键，也必须覆写。
2. 【强制】ArrayList 的 subList 结果不可强转成 ArrayList，否则会抛出 ClassCastException 异常。
3. 【强制】使用 Map 的方法 keySet()/values()/entrySet() 返回集合对象时，不可以对其进行添加元素操作，否则会抛出 UnsupportedOperationException 异常。
4. 【强制】Collections 类返回的对象如 emptyList()/singletonList() 等都是 immutable list，不可对其进行添加或者删除元素的操作。
5. 【强制】在 subList 场景中，对原集合元素的增加或删除，均会导致子列表的遍历、增加、删除产生 ConcurrentModificationException 异常。
6. 【强制】使用集合转数组的方法，必须使用集合的 toArray(T[] array)，传入的是类型完全一致、长度为 0 的空数组。
7. 【强制】在使用 Collection 接口任何实现类的 addAll() 方法时，都要对输入的集合参数进行 NPE 判断。
8. 【强制】使用工具类 Arrays.asList() 把数组转换成集合时，不能使用其修改集合相关的方法，它的 add/remove/clear 方法会抛出 UnsupportedOperationException 异常。
9. 【强制】泛型通配符 <? extends T> 来接收返回的数据，此写法的泛型集合不能使用 add 方法，而 <? super T> 不能使用 get 方法，作为接口调用赋值时易出错。
10. 【强制】在无泛型限制定义的集合赋值给泛型限制的集合时，在使用集合元素时，需要进行 instanceof 判断，避免抛出 ClassCastException 异常。
11. 【强制】不要在 foreach 循环里进行元素的 remove/add 操作。remove 元素请使用 Iterator 方式，如果并发操作，需要对 Iterator 对象加锁。
12. 【强制】在 JDK7 版本及以上，Comparator 实现类要满足三个条件（对称性、传递性、一致性），不然 Arrays.sort 和 Collections.sort 会抛 IllegalArgumentException 异常。
13. 【推荐】集合泛型定义时，在 JDK7 及以上，使用 diamond 语法或全省略。
14. 【推荐】集合初始化时，指定集合初始值大小。
15. 【推荐】使用 entrySet 遍历 Map 类集合 KV，而不是 keySet 方式进行遍历。
16. 【推荐】高度注意 Map 类集合 K/V 能不能存储 null 值的情况——Hashtable/ConcurrentHashMap 不允许 null key 和 null value；TreeMap 不允许 null key 但允许 null value；HashMap 均允许。
17. 【参考】合理利用好集合的有序性(sort)和稳定性(order)，避免无序性和不稳定性带来的负面影响。
18. 【参考】利用 Set 元素唯一的特性，可以快速对一个集合进行去重操作，避免使用 List 的 contains 方法进行遍历、对比、去重操作。

## 八、控制语句

1. 【强制】在一个 switch 块内，每个 case 要么通过 continue/break/return 等来终止，要么注释说明程序将继续执行到哪一个 case 为止；在一个 switch 块内，都必须包含一个 default 语句并且放在最后，即使它什么代码也没有。
2. 【强制】当 switch 括号内的变量类型为 String 并且此变量为外部参数时，必须先进行 null 判断。
3. 【强制】在 if/else/for/while/do 语句中必须使用大括号。
4. 【强制】在高并发场景中，避免使用"等于"判断作为中断或退出的条件。
5. 【推荐】表达异常的分支时，少用 if-else 方式，超过 3 层的 if-else 逻辑判断可以使用卫语句、策略模式、状态模式等来实现。**注：翻译阶段此条为【推荐】级别，不覆盖「不重构」原则；review 阶段可标记为改进建议但不作为 mustFix。**
6. 【推荐】除常用方法外，不要在条件判断中执行其它复杂的语句，将复杂逻辑判断的结果赋值给一个有意义的布尔变量名，以提高可读性。
7. 【推荐】不要在其它表达式（尤其是条件表达式）中，插入赋值语句。
8. 【推荐】循环体中的语句要考量性能，定义对象、变量、获取数据库连接、不必要的 try-catch 操作尽量移至循环体外处理。
9. 【推荐】避免采用取反逻辑运算符。
10. 【推荐】接口入参保护，这种场景常见的是用作批量操作的接口。
11. 【参考】下列情形需要进行参数校验：调用频次低的方法、执行时间开销很大的方法、需要极高稳定性和可用性的方法、对外提供的开放接口、敏感权限入口。
12. 【参考】下列情形不需要进行参数校验：极有可能被循环调用的方法、底层调用频度比较高的方法、被声明成 private 只会被自己代码所调用的方法且能确定参数已检查。

## 九、事务与批量处理

### 9.1 事务管理

```java
@Service
@Slf4j
@RequiredArgsConstructor
public class OrderServiceImpl implements OrderService {

    private final OrderMapper orderMapper;

    @Override
    @Transactional(rollbackFor = Exception.class)
    public void saveOrder(OrderDO order) {
        // 业务逻辑
    }

    @Override
    @Transactional(readOnly = true)
    public OrderDO queryOrder(Long id) {
        return orderMapper.selectById(id);
    }
}
```

**规约要点：**
1. 【强制】涉及数据修改的 ServiceImpl 方法必须标注 `@Transactional(rollbackFor = Exception.class)`。
2. 【强制】使用 `rollbackFor = Exception.class` 确保所有异常都回滚。
3. 【强制】事务标注在 ServiceImpl 方法上（Service 接口不标事务）。
4. 【推荐】只读查询方法可加 `@Transactional(readOnly = true)`。

### 9.2 批量处理

```java
for (OrderDO order : orderList) {
    try {
        saveOrder(order);
    } catch (Exception e) {
        log.error("处理失败, orderId={}", order.getId(), e);
        // 单条失败不影响其他记录；按业务需求决定是否记录错误后继续
    }
}
```

**规约要点：**
1. 【强制】批量处理在 ServiceImpl 内循环，单条记录失败按业务需求决定是否影响其他记录。
2. 【强制】大批量更新必须分批处理（如 `SplitListUtil.splitList(list, 1000)`）。

## 十、数据字典与常量

包级常量集中到 per-package 的 `{Pkg}Constant` 常量类（见 §3.4，由 scaffold 从 inventory `constants` 生成，位于 `constant/`）。纯常量包（无子程序）的 `{Pkg}Constant` 即其唯一 Java 产物：

```java
// 纯常量包的 {Pkg}Constant（scaffold 生成，字段全 static final）
public final class FConstConstant {
    private FConstConstant() { }
    public static final String PUB = "PUB";        // 字典源
    public static final String DIC40058 = "40058"; // 字典编号
}
```

**规约要点：**
1. 【强制】不允许任何魔法值（未经预先定义的常量）直接出现在代码中。
2. 【强制】`long`/`Long` 赋值时数值后使用大写 `L`，不得用小写 `l`。
3. 【推荐】常量按功能归类，不集中在一个常量类中维护。

## 十一、MyBatis Mapper 规范

### 11.1 Mapper 接口

```java
public interface OrderMapper {
    List<OrderDO> queryOrderList(Map<String, Object> params);
    void insertOrder(OrderDO order);
    void updateOrderStatus(OrderDO order);
    void batchUpdateOrderStatus(@Param("ids") List<Long> ids,
                                @Param("status") String status);
}
```

### 11.2 XML 映射

```xml
<!-- 存储过程调用 -->
<select id="callAddDeal" statementType="CALLABLE">
    CALL r_add_ctp(
        #{dealNumber, mode=IN},
        #{tradeDate, mode=IN},
        #{oiFlag, mode=OUT, jdbcType=VARCHAR},
        #{osMsg, mode=OUT, jdbcType=VARCHAR}
    )
</select>
```

**规约要点：**
1. 【强制】表查询一律不使用 `*`，必须明确写明字段。
2. 【强制】即使类属性名与数据库字段一一对应，也必须定义 `resultMap`，不得用 `resultClass`/`resultType` 自动映射。
3. 【强制】SQL 参数使用 `#{}`，禁止使用 `${}`（SQL 注入风险）。
4. 【强制】存储过程调用使用 `statementType="CALLABLE"`，OUT 参数标注 `mode=OUT` 与 `jdbcType`。
5. 【推荐】`@Transactional` 不要滥用，事务处需考虑各方面回滚方案。

## 十二、转换检查清单

> 以下为**单个存储过程**的翻译落位顺序，指导 translator 把同一 SP 的逻辑落到 per-proc 类（`{Proc}Service`/`{Proc}ServiceImpl`/`{Proc}Mapper`）；与工作流 stage 顺序（inventory→scaffold→translate→dedup→review→verify）是两个维度，勿混淆。

转换 PL/SQL 存储过程时，按以下顺序执行：

1. **Inventory**：扫描存储过程，识别输入/输出参数、业务逻辑、依赖对象。
2. **Entity/DTO**：识别过程参数与返回值对应的数据对象（复用全局 DO 或新建 per-proc `{Proc}DTO`，落 `dto/`）。
3. **`{Pkg}Constant`/`{Pkg}StateDTO`**：确认包级常量/变量已在 scaffold 生成的 `constant/{Pkg}Constant` 与 `dto/{Pkg}StateDTO` 中（只读引用，不重建）。
4. **`{Proc}Mapper`**：识别 DML/查询/存储过程调用，落到 per-proc Mapper 接口方法（`mapper/`）+ XML（`resources/mapper/`）。
5. **`{Proc}Service`**：为该过程入口声明公共方法签名（`service/`）。
6. **`{Proc}ServiceImpl`**：将核心业务逻辑、变量初始化、校验、事务、异常处理落到 per-proc ServiceImpl 方法（`service.impl/`）；包常量经 `{Pkg}Constant.字段` 静态访问，包变量读写经注入 `{Pkg}StateDTO` bean 访问。
7. **跨包调用**：将跨包调用封装为被调方 `{Proc}Service` 接口注入（FQN `service.{ResolvedBase}Service`）。
8. **测试**：编写 `{Proc}ServiceImpl` 单元测试（`service.impl/`）验证等价性 + `{Proc}Mapper` 集成测试（`mapper/`）。

## 十三、常见陷阱与注意事项

1. 【强制】事务边界：`@Transactional` 标在 ServiceImpl 写方法上，rollbackFor = Exception.class。
2. 【强制】异常体系：统一用 `exception` 包下的 `BusinessException` 体系，禁止 `new RuntimeException()`/`Exception`/`Throwable`。
3. 【强制】依赖注入：构造器注入（`@RequiredArgsConstructor` + `final`），禁止 `@Autowired` 字段注入。
4. 【强制】日志：`@Slf4j` + `log.xxx`，禁止自定义日志门面、禁止手写 LoggerFactory。
5. 【强制】批量更新：超过 1000 条记录必须分批处理。
6. 【强制】空值处理：查询结果为空按业务语义返回 null 或抛 `DataNotFoundException`，并在 Javadoc `@return` 说明。
7. 【强制】POJO 属性用包装类型，不设默认值。

---

## 十四、基础设施类模板

> scaffold 阶段在 `src/main/java/exception/` 与 `util/` 下生成下列基础设施类（最小可编译 stub，包名 `exception` / `util`，无根包）。所有类遵循本规约：中文 Javadoc、`@author`/`@version`/`@since`。真实实现由项目方后续补充。

### 14.1 BusinessException（业务异常基类）

**unchecked** 异常，继承 `RuntimeException`；所有业务异常的基类。

```java
public class BusinessException extends RuntimeException {
    private static final long serialVersionUID = 1L;
    public BusinessException(String message) { super(message); }
    public BusinessException(String message, Throwable cause) { super(message, cause); }
}
```

### 14.2 DataNotFoundException（数据未找到）

```java
public class DataNotFoundException extends BusinessException {
    private static final long serialVersionUID = 1L;
    public DataNotFoundException(String message) { super(message); }
    public DataNotFoundException(String message, Throwable cause) { super(message, cause); }
}
```

### 14.3 ValidationException（校验失败）

```java
public class ValidationException extends BusinessException {
    private static final long serialVersionUID = 1L;
    public ValidationException(String message) { super(message); }
    public ValidationException(String message, Throwable cause) { super(message, cause); }
}
```

### 14.4 StringUtil（字符串工具，Java 8 兼容）

**禁止** `String.isBlank()`/`strip()`（Java 9+ API）。

```java
public final class StringUtil {
    private StringUtil() { }
    public static boolean isBlank(String s) { return s == null || s.trim().isEmpty(); }
    public static boolean isNotBlank(String s) { return !isBlank(s); }
    public static boolean isEmpty(String s) { return s == null || s.isEmpty(); }
}
```

### 14.5 SplitListUtil（分批工具）

批量处理超 1000 条时使用。

```java
import java.util.ArrayList;
import java.util.List;
public final class SplitListUtil {
    private SplitListUtil() { }
    public static <T> List<List<T>> splitList(List<T> list, int batchSize) {
        List<List<T>> result = new ArrayList<>();
        if (list == null || list.isEmpty() || batchSize <= 0) return result;
        int total = list.size();
        for (int i = 0; i < total; i += batchSize) {
            result.add(list.subList(i, Math.min(i + batchSize, total)));
        }
        return result;
    }
}
```

---

## 【强制】Java 版本与框架配置（唯一事实来源）

> **此段落是所有版本和框架决策的唯一权威来源。scaffold 的 javaVersion / springBootVersion、
> pom.xml 的构建配置、代码中的 API 使用，都必须与此段落完全一致。agent 不得使用自选默认值覆盖。**
>
> **如需切换目标 Java 版本，只需修改此段落后重新运行工作流，所有 agent 将自动遵循新配置。**

### 目标版本

- **Java 版本**: 1.8（JDK 8）
- **Spring Boot 版本**: 2.7.x（最后一个支持 Java 8 的版本，禁止使用 3.x）
- **MyBatis starter**: mybatis-spring-boot-starter 2.x（禁止使用 mybatis-plus-spring-boot3-starter）

### 依赖命名空间

- Servlet API: `javax.servlet`（禁止 `jakarta.servlet`）
- Validation API: `javax.validation`（禁止 `jakarta.validation`）
- Persistence API: `javax.persistence`（禁止 `jakarta.persistence`）
- 所有依赖版本必须兼容 Java 8，禁止引入任何需要 Java 9+ 的库

### pom.xml 构建配置

- `<java.version>1.8</java.version>`
- `<maven.compiler.source>1.8</maven.compiler.source>`
- `<maven.compiler.target>1.8</maven.compiler.target>`
- Spring Boot parent 版本必须为 2.7.x

### 禁止的 Java 9+ 语法和 API

**所有生成的 Java 代码必须兼容 Java 1.8（JDK 8）标准，禁止使用 Java 9 及以上版本引入的语法和 API。** 具体要求：

1. 【强制】禁止使用 `var` 关键字（Java 10+），所有局部变量必须显式声明类型。
2. 【强制】禁止使用 `List.of()`、`Map.of()`、`Set.of()` 等不可变集合工厂方法（Java 9+），应使用 `Collections.unmodifiableList()` 或 `Arrays.asList()` 等方式替代。
3. 【强制】禁止使用 `Optional.ifPresentOrElse()`、`Optional.or()`、`Optional.stream()` 等方法（Java 9+），仅允许使用 Java 8 中 `Optional` 的方法。
4. 【强制】禁止使用 `Stream.takeWhile()`、`Stream.dropWhile()`、`Stream.ofNullable()` 等方法（Java 9+）。
5. 【强制】禁止使用 `String.isBlank()`、`String.strip()`、`String.stripLeading()`、`String.stripTrailing()`、`String.lines()`、`String.repeat()` 等方法（Java 11+），应使用 `trim()` 和自行实现等 Java 8 兼容方式。
6. 【强制】禁止使用 `HttpClient` API（Java 11+），网络请求使用 `HttpURLConnection` 或第三方库。
7. 【强制】禁止使用 `record` 关键字（Java 14+ 预览 / Java 16+ 正式），使用传统 class 替代。
8. 【强制】禁止使用 `sealed` / `permits` / `instanceof` 模式匹配（Java 15+ / Java 16+）。
9. 【强制】禁止使用文本块 `"""`（Java 13+ 预览 / Java 15+ 正式），字符串拼接使用 `+` 或 `StringBuilder`。
10. 【强制】禁止使用 `switch` 表达式（Java 12+ 预览 / Java 14+ 正式），使用传统 `switch` 语句。
11. 【强制】Lambda 和 Stream API 可正常使用（Java 8 已引入），但不得使用 Java 9+ 新增的增强功能。
12. 【强制】Maven/Gradle 构建配置中 `source` 和 `target` 必须设置为 `1.8`。
