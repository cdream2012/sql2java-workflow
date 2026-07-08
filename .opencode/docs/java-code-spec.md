# Java 代码规约

> 此规约由工作流引擎自动注入到 java-architect、translator、reviewer 三个 agent 的 system prompt 中。
> 修改此文件即可全局生效，无需同步修改多个 agent 文件。
> 用户也可通过 `--spec` 参数提供自定义规约文件（按 `##` 章节覆盖同名内置章节，独有章节追加）。

## 适用范围

适用于 PL/SQL 存储过程 → 基于 **DDD 领域驱动分层** 的 Spring Boot + MyBatis 工程翻译场景。规约主体为分层架构与存储过程→Java 组件映射规约；版本与框架配置见末尾【强制】段落。

> **包根项目特定**：规约中出现的 `com.icbc.fmhm` 仅为举例，实际包根由 plan 阶段按目标项目推导（如 `com.example.mfgerp`、`com.icbc.fmhm` 等），规约不规定固定包根。工程结构路径用 `{packageBase}`（项目根包）与 `{module}`（模块名）占位符表达。

> **工程结构章节**：下方 `## 工程结构` 为单模块的 DDD 分层目录布局模板。`{packageBase}` = plan.json 的 targetProject.packageBase（项目根包）；`{module}` = packageMapping 的模块名。scaffold 按每个 Oracle 包对应的模块复制此布局（基础设施层 `common/infrastructure` 为项目级共享，按 packageBase 只建一次）。该章节正文仅含可解析路径（行内 `#` 注释由引擎剥离），供 `--spec` 结构提取与 scaffold 消费。

## 工程结构

src/main/java/{packageBase}/{module}/access            # 接入层（对外接口）
src/main/java/{packageBase}/{module}/access/impl       # 接入层实现
src/main/java/{packageBase}/{module}/processor         # 处理器层（流程编排）
src/main/java/{packageBase}/{module}/domain/aggregate  # 聚合根（业务逻辑编排）
src/main/java/{packageBase}/{module}/domain/builder    # 构建器（参数/数据构建）
src/main/java/{packageBase}/{module}/domain/validator  # 验证器（业务规则校验）
src/main/java/{packageBase}/{module}/common/outservice # 外部服务接口
src/main/java/{packageBase}/{module}/common/outservice/impl
src/main/java/{packageBase}/{module}/common/utils      # 工具类
src/main/java/{packageBase}/common/infrastructure      # 基础设施（TranFailException/CommonLog 等，项目级共享）
src/main/java/{packageBase}/beans                      # 数据对象（XxxBean，项目级共享）
src/main/java/{packageBase}/mapper                     # Mapper 接口（项目级共享）
src/main/resources/mapper                              # MyBatis Mapper XML
src/test/java/{packageBase}/{module}                   # 测试代码

## 一、分层架构规范

### 1.1 分层职责

| 层级 | 包名 | 职责 | 对应存储过程概念 |
|------|------|------|------------------|
| **Access** | `access` | 对外接口暴露，参数接收 | 存储过程入口/包规范 |
| **Processor** | `processor` | 流程编排、事务边界、异常处理 | 主存储过程调用链 |
| **Aggregate** | `domain.aggregate` | 业务逻辑编排、状态管理 | 核心业务逻辑包 |
| **Builder** | `domain.builder` | 参数构建、数据转换、默认值填充 | 变量初始化/参数组装 |
| **Validator** | `domain.validator` | 业务规则校验、数据合法性检查 | 前置条件检查/约束校验 |
| **OutService** | `common.outservice` | 跨域服务调用（如 pv 计算） | 跨包/跨 schema 调用 |
| **Utils** | `common.utils` | 通用工具方法 | 公共函数库 |

**规约要点：**
1. 【强制】每个存储过程入口（PROCEDURE/FUNCTION）映射为一组 Access + Processor + Aggregate 组件，不得缺层。
2. 【强制】Access 层只做参数接收与转发，**不含业务逻辑**；业务逻辑必须下沉到 Aggregate。
3. 【强制】Processor 层负责流程编排与异常捕获，**不标注 `@Transactional`**；事务边界由 Aggregate 层控制。
4. 【强制】主存储过程含多个子流程（子程序调用 / 顺序逻辑段 / 跨包调用）时，**Processor 必须按原 PL/SQL 调用顺序编排多个 Aggregate 步骤方法 / 跨单元 `AccessIntf` 调用 / `OutService` 调用**，体现"主存储过程调用链"，**禁止将整条流程折叠为单个 Aggregate 方法**；Aggregate 每个步骤一个方法，Processor 不含业务逻辑。步骤单一的主存储过程保持 Aggregate 单方法，不强拆。拆分依据是原 SP 的调用结构（调用语句边界），属忠实呈现而非重构，不违反"不重构"原则。
5. 【强制】跨包/跨 schema 调用必须封装为 OutService，不得在 Aggregate 中直接引用他包 Mapper。
6. 【强制】接入层接口 `AccessIntf` 方法签名统一 `Map<String,Object> xxx(Map<String,Object> inputMap)`，返回 `Map<String,Object>`（含 `oiFlag`/`osMsg` + 业务结果键），禁止 `void` 返回、禁止 Bean 暴露到接入层；`AccessImpl` 负责 Map↔Bean 适配（委托 `Builder` 转换），内部 Processor/Aggregate 保持 Bean。

## 二、核心设计模式

### 2.1 聚合模式（Aggregate）

聚合根是领域层的核心，负责编排业务流程。

```java
@Component
public class XxxAggregate implements Serializable {
    private static final long serialVersionUID = 1L;

    // 依赖注入
    @Autowired private XxxMapper xxxMapper;
    @Autowired private XxxBuilder xxxBuilder;
    @Autowired private XxxValidator validator;

    // 聚合根内部状态
    private List<XxxBean> beans = new ArrayList<>();

    // 业务方法，编排 Builder + Validator + Mapper
    @Transactional(rollbackFor = Exception.class)
    public void processXxx(XxxBean bean) throws TranFailException {
        Map<String, Object> params = xxxBuilder.buildParams(bean);
        validator.validate(bean);
        xxxMapper.save(bean, params);
        updateStatus(bean);
    }
}
```

**规约要点：**
1. 【强制】聚合根持有 Builder、Validator、Mapper 的引用（`@Autowired` 注入）。
2. 【强制】聚合根业务方法必须声明 `throws TranFailException`。
3. 【强制】涉及数据修改的聚合根方法必须标注 `@Transactional(rollbackFor = Exception.class)`。
4. 【强制】聚合根实现 `Serializable`，声明 `serialVersionUID`。
5. 【推荐】聚合根内部维护业务状态集合（如 `beans` 列表）。

### 2.1.1 多步骤 Processor 编排（主存储过程含多个子流程）

当主存储过程体内顺序调用了多个子流程（如期权交易新增：预审批单比对 → 交易对手池校验 → 币种/币种对判断 → 交易新增 → 业务协议新增 → ump 序列新增 → 重置序列新增 → 估值任务新增），Aggregate 按原 PL/SQL 顺序为每个步骤生成一个方法，Processor 按序编排，**Processor 不含任何业务逻辑**，只做调用编排 + 异常捕获 + 状态流转。

```java
// Aggregate：每个业务步骤一个方法，步骤内做实际业务操作（编排 Builder+Validator+Mapper）
@Component
public class FmbmAggregate implements Serializable {
    private static final long serialVersionUID = 1L;

    @Autowired private FmbmBuilder fmbmBuilder;
    @Autowired private FmbmValidator fmbmValidator;
    @Autowired private FmbmMapper fmbmMapper;

    /** 预审批单比对 */
    @Transactional(rollbackFor = Exception.class)
    public void comparePreApprove(FmbmBean bean) throws TranFailException {
        // 业务逻辑：Builder 组装参数 + Validator 校验 + Mapper 调用
    }

    /** 交易对手池校验 */
    public void checkCounterpartyPool(FmbmBean bean) throws TranFailException {
        // 业务逻辑
    }

    /** 交易新增 */
    @Transactional(rollbackFor = Exception.class)
    public void addTrade(FmbmBean bean) throws TranFailException {
        // 业务逻辑
    }

    /** 业务协议新增 */
    @Transactional(rollbackFor = Exception.class)
    public void addBizAgreement(FmbmBean bean) throws TranFailException {
        // 业务逻辑
    }

    // ump 序列新增 / 重置序列新增 / 估值任务新增 …… 同样按步骤拆方法
}

// Processor：按原 PL/SQL 调用顺序编排各步骤，不含业务逻辑
@Component
public class FmbmProcessor {
    @Autowired private FmbmAggregate fmbmAggregate;

    /**
     * 期权交易新增流程编排
     * <p>按原存储过程调用链顺序编排各业务步骤，单步失败捕获并更新状态</p>
     */
    public void addFmbmTrade(FmbmBean bean) {
        try {
            fmbmAggregate.comparePreApprove(bean);
            fmbmAggregate.checkCounterpartyPool(bean);
            fmbmAggregate.addTrade(bean);
            fmbmAggregate.addBizAgreement(bean);
            // fmbmAggregate.addUmpSeq(bean); ... 按 PL/SQL 原顺序继续编排
        } catch (Exception e) {
            CommonLog.error("期权交易新增异常：" + e.getMessage(), e);
            bean.setExpInfo(e.getMessage().length() > 1000
                ? e.getMessage().substring(0, 1000)
                : e.getMessage());
            bean.setProcStat("0");
        }
    }
}
```

**规约要点：**
1. 【强制】Processor 方法体内只允许出现对 Aggregate 步骤方法 / `AccessIntf` / `OutService` 的顺序调用、批量循环、try-catch 状态流转，**禁止出现 Mapper/Builder/Validator 直调与业务判断逻辑**。
2. 【强制】Aggregate 步骤方法的拆分边界 = 原 PL/SQL 的调用语句边界 / call block，顺序与原存储过程体一致；不得凭空合并或新增步骤。
3. 【强制】步骤单一的主存储过程保持 Aggregate 单方法、Processor 单次调用，不强拆。

### 2.2 Builder 模式

Builder 负责参数构建、数据转换、默认值填充。

```java
@Component
public class XxxBuilder {
    public Map<String, Object> buildQueryParams(String userGroupId, String workDate) {
        Map<String, Object> params = new HashMap<>();
        params.put("userGroupId", userGroupId);
        params.put("workDate", workDate);
        params.put("language", "zh_CN");        // 默认值
        return params;
    }

    // 构建存储过程输出参数模板——所有 OUT 参数预定义并初始化为空字符串
    public Map<String, Object> buildOutputParams() {
        Map<String, Object> out = new HashMap<>();
        out.put("oiFlag", "");
        out.put("osMsg", "");
        return out;
    }

    public void initBean(XxxBean bean) {
        bean.setProcStat("0");
        bean.setExpInfo("成功导入");
    }
}
```

**规约要点：**
1. 【强制】Builder 方法命名：`buildXxxParams()` / `initXxx()`。
2. 【强制】存储过程的所有 OUT 参数必须在 Builder 中预定义并初始化为空字符串，不得遗漏。
3. 【强制】日期格式转换统一在 Builder 中完成（如 `yyyy-MM-dd` → `yyyymmdd`）。
4. 【强制】字典值转换逻辑放在 Builder 中，不得放在 Validator 中。
5. 【推荐】Bean 必填字段的默认值填充在 `initXxx()` 中集中完成。

### 2.3 Validator 模式

Validator 负责业务规则校验。

```java
@Component
public class XxxValidator {
    public void validate(XxxBean bean) throws TranFailException {
        if (bean == null) {
            throw new TranFailException("交易对象为空");
        }
        if (StringUtil.isBlank(bean.getBusinessId())) {
            bean.setProcStat("0");
            bean.setExpInfo("业务编号为空");
            throw new TranFailException("业务编号为空");
        }
    }

    public void processResult(Map<String, Object> outParams, XxxBean bean) throws TranFailException {
        String oiFlag = String.valueOf(outParams.get("oiFlag"));
        String osMsg = String.valueOf(outParams.get("osMsg"));
        if (!"0".equals(oiFlag)) {
            bean.setProcStat("0");
            bean.setExpInfo("交易失败：" + osMsg);
            throw new TranFailException("交易失败：" + osMsg);
        }
    }
}
```

**规约要点：**
1. 【强制】校验失败必须设置 `procStat="0"` 和 `expInfo` 后再抛 `TranFailException`。
2. 【强制】校验方法必须声明 `throws TranFailException`。
3. 【强制】存储过程 OUT 参数结果校验统一在 Validator 中处理。
4. 【强制】校验顺序：非空校验 → 格式校验 → 业务规则校验。

## 三、存储过程转换映射规则

### 3.1 存储过程 → Java 组件映射

| 存储过程元素 | Java 对应组件 | 说明 |
|-------------|---------------|------|
| `PROCEDURE/FUNCTION` 入口 | `AccessIntf` + `AccessImpl` | 对外接口 |
| 主流程逻辑 | `Processor` | 流程编排 |
| 核心业务逻辑 | `Aggregate` | 聚合根 |
| 变量声明/初始化 | `Builder.initXxx()` | 默认值填充 |
| 参数组装 | `Builder.buildXxxParams()` | 参数构建 |
| IF-THEN-ELSE 校验 | `Validator.validateXxx()` | 业务校验 |
| 跨包调用 | `OutService` | 外部服务 |
| 公共函数 | `Utils` | 工具类 |
| `COMMIT/ROLLBACK` | `@Transactional` | 事务管理 |

### 3.2 OUT 参数处理规范

【强制】存储过程的 OUT 参数必须在 Builder 中预定义，调用前初始化为空字符串。

```java
public Map<String, Object> buildAddDealOutputParams() {
    Map<String, Object> paramIn = new HashMap<>();
    paramIn.put("oiFlag", "");
    paramIn.put("osMsg", "");
    paramIn.put("osDealId", "");
    return paramIn;
}
```

```java
// Aggregate 中调用
Map<String, Object> outputParams = xxxBuilder.buildAddDealOutputParams();
xxxMapper.addDeal(bean, outputParams);
validator.processResult(outputParams, bean);
```

### 3.3 异常处理规范

```java
// Processor 层：捕获异常，记录日志，更新状态
try {
    xxxAggregate.processXxx(bean);
} catch (Exception e) {
    CommonLog.error("处理异常：" + e.getMessage(), e);
    bean.setExpInfo(e.getMessage().length() > 1000
        ? e.getMessage().substring(0, 1000)
        : e.getMessage());
    bean.setProcStat("0");
    xxxAggregate.updateStatus(bean);
}

// Aggregate 层：抛出 TranFailException
public void saveDeal(XxxBean bean) throws TranFailException {
    try {
        // 业务逻辑
    } catch (Exception e) {
        CommonLog.error("Exception When saveDeal: " + e.getMessage(), e);
        bean.setProcStat("0");
        bean.setExpInfo("保存交易出现异常：" + e.getMessage());
        throw new TranFailException("保存交易出现异常：" + e.getMessage());
    }
}
```

**规约要点：**
1. 【强制】统一使用 `TranFailException` 作为业务异常类型，禁止抛出 `new RuntimeException()`、`Exception` 或 `Throwable`。各层方法声明 `throws TranFailException` 见 2.1（Aggregate）/ 2.3（Validator）。
2. 【强制】异常信息长度超过 1000 字符时必须截断，避免数据库字段溢出。
3. 【强制】Processor 层捕获异常后必须更新 `procStat` 和 `expInfo`。
4. 【强制】catch 块不得丢弃原始异常信息：必须包装重抛（`throw new TranFailException(msg, e)`）或经 `CommonLog.error(msg, e)` 记录完整堆栈（日志规范详见 4.3）；禁止空 catch、禁止仅打印 `e.getMessage()` 丢弃堆栈。

## 四、编码规范

### 4.1 命名规范

| 类型 | 命名规则 | 示例 |
|------|----------|------|
| Access 接口 | `XxxAccessIntf` | `IrsCcsDealAccessIntf` |
| Access 实现 | `XxxAccessImpl` | `IrsCcsDealAccessImpl` |
| Processor | `XxxProcessor` | `IrsCcsDealProcessor` |
| Aggregate | `XxxAggregate` | `IrsCcsDealAggregate` |
| Builder | `XxxBuilder` | `IrsCcsDealBuilder` |
| Validator | `XxxValidator` | `IrsCcsDealValidator` |
| Bean/DTO | `XxxBean` | `IrsCcsDealBean` |
| Mapper | `XxxMapper` | `IntCfcIrsDealMapper` |

**规约要点：**
1. 【强制】类名 UpperCamelCase；方法名、参数名、成员变量、局部变量 lowerCamelCase；常量全大写下划线分隔；包名全小写。
2. 【强制】数据对象统一使用 `XxxBean` 后缀，禁止使用 `XxxDO`/`XxxPOJO`。
3. 【强制】POJO 类布尔属性不加 `is` 前缀；数据库布尔字段必须加 `is_`，在 resultMap 中映射。
4. 【强制】命名不得以下划线或美元符号开始或结束；严禁拼音与英文混合，禁止直接使用中文。
5. 【强制】抽象类用 `Abstract`/`Base` 开头；异常类用 `Exception` 结尾；测试类以被测类名开头、`Test` 结尾。
6. 【推荐】Service/DAO 层方法前缀：`get` 取单个、`list` 取多个、`count` 取统计、`save/insert` 插入、`remove/delete` 删除、`update` 修改。
7. 【参考】类名前缀（如示例中的 `Int`/`Cfc` 等）为**项目特定的命名约定**，由 plan 阶段按目标项目推导，非强制；非该约定项目不得照抄此前缀。

### 4.2 注释规范

```java
/**
 * IRS 交易处理器（应用层）
 * <p>负责 IRS 交易导入流程，协调聚合根完成交易验证、计算、存储等步骤</p>
 * <p>主要处理流程：</p>
 * <ol>
 *     <li>获取用户组 ID 并校验</li>
 *     <li>构建查询参数获取交易列表</li>
 *     <li>遍历交易列表逐个处理</li>
 * </ol>
 * @author kfzx-zhangc
 * @version 1.0
 * @since 2026-06-05
 */
@Component
public class IrsCcsDealProcessor {
```

**规约要点：**
1. 【强制】所有注释必须使用中文（Javadoc、行内注释、TODO 标记等），专有名词（Spring、MyBatis、Mapper 等）与 Java 关键字保持英文原文。
2. 【强制】类、类属性、类方法的注释使用 Javadoc 规范（`/** 内容 */`），不得使用 `// xxx`。
3. 【强制】类注释必须包含：职责描述、主要流程、`@author`、`@version`、`@since`。`@author` 为**项目特定的开发者标识**，由 plan 阶段按目标项目推导（示例 `kfzx-zhangc` 仅 ICBC 举例），非该项目不得照抄。
4. 【强制】方法注释必须包含：功能描述、参数说明、返回值、异常说明。
5. 【推荐】复杂逻辑使用 `<ol>`/`<ul>` 列表说明步骤。

### 4.3 日志规范

```java
CommonLog.info("IrsDealAutoImportAppService start autoImportDeal");
CommonLog.error("处理交易异常：" + e.getMessage(), e);
CommonLog.info("seq:" + bean.getSeq() + ", execution time: " + time + "ms");
```

**规约要点：**
1. 【强制】统一使用 `CommonLog` 记录日志，禁止直接使用 Log4j/Logback API。
2. 【强制】方法入口/出口必须记录 info 日志。
3. 【强制】异常必须记录 error 日志并附带完整堆栈。
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
9. 【强制】定义数据对象 Bean 类时，属性类型要与数据库字段类型相匹配。
10. 【强制】为了防止精度损失，禁止使用构造方法 BigDecimal(double) 的方式把 double 值转化为 BigDecimal 对象。推荐入参为 String 的构造方法，或使用 BigDecimal.valueOf 方法。
11. 【强制】所有的 POJO 类属性必须使用包装数据类型。【强制】RPC 方法的返回值和参数必须使用包装数据类型。【推荐】所有的局部变量使用基本数据类型。
12. 【强制】定义 Bean 等 POJO 类时，不要设定任何属性默认值（业务默认值在 Builder.initXxx() 中填充）。
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
24. 【推荐】类成员与方法访问控制从严——构造方法最小可见、静态工具类私有构造禁止 public、成员变量和方法最小可见原则。（注：@Component 注解的 Bean/Builder/Validator/Aggregate 等由 Spring 实例化，构造方法保留 public；本条针对静态工具类。）

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
@Transactional(rollbackFor = Exception.class)
public void saveDeal(IrsCcsDealBean bean) throws TranFailException {
    // 业务逻辑
}
```

**规约要点：**
1. 【强制】涉及数据修改的 Aggregate 方法必须标注 `@Transactional`。
2. 【强制】使用 `rollbackFor = Exception.class` 确保所有异常都回滚。
3. 【强制】Processor 层不标注事务，由 Aggregate 层控制事务边界。

### 9.2 批量处理

```java
for (IrsCcsDealBean bean : dealList) {
    try {
        xxxAggregate.initDealFromIntDeal(bean, switchFlag);
        xxxAggregate.saveDeal(bean);
    } catch (Exception e) {
        bean.setProcStat("0");
        bean.setExpInfo(errorMsg);
        xxxAggregate.updateStatus(bean);
    }
}
```

**规约要点：**
1. 【强制】批量处理在 Processor 层循环，单条记录失败不影响其他记录。
2. 【强制】失败记录必须更新状态为 `"0"` 并记录错误信息。
3. 【强制】大批量更新必须分批处理（如 `SplitListUtil.splitList(list, 1000)`）。

## 十、数据字典与常量

```java
// 聚合根中定义常量
protected static final String PUB = "PUB";        // 字典源
protected static final String DIC40058 = "40058"; // 字典编号

// Builder 中定义常量
private static final String LANGUAGE = "zh_CN";
```

**状态码约定：**

| 状态码 | 含义 |
|--------|------|
| `procStat = "1"` | 处理成功 |
| `procStat = "0"` | 处理失败 |
| `procStat = "7"` | 处理中 |
| `switchFlag = "1"` | 开关打开 |
| `switchFlag = "0"` | 开关关闭 |

**规约要点：**
1. 【强制】不允许任何魔法值（未经预先定义的常量）直接出现在代码中。
2. 【强制】`long`/`Long` 赋值时数值后使用大写 `L`，不得用小写 `l`。
3. 【推荐】常量按功能归类，不集中在一个常量类中维护。

## 十一、MyBatis Mapper 规范

### 11.1 Mapper 接口

```java
public interface IntCfcIrsDealMapper {
    List<IrsCcsDealBean> queryDealList(Map<String, Object> params);
    void addDeal(IrsCcsDealBean bean, Map<String, Object> outParams);
    void updateDealStatus(IrsCcsDealBean bean);
    void batchUpdateDealStatus(@Param("seqs") List<String> seqs,
                               @Param("procStatus") String procStatus,
                               @Param("expInfo") String expInfo);
}
```

### 11.2 XML 映射

```xml
<!-- 存储过程调用 -->
<select id="addDeal" statementType="CALLABLE">
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

> 以下为**单个存储过程**的翻译落位顺序（Builder→Validator→Aggregate→…→Access），指导 translator 把同一 SP 的逻辑拆到各层组件；与工作流 stage 顺序（inventory→analyze→plan→scaffold→translate→dedup→review→verify）是两个维度，勿混淆。

转换 PL/SQL 存储过程时，按以下顺序执行：

1. **Inventory**：扫描存储过程，识别输入/输出参数、业务逻辑、依赖对象。
2. **Builder**：将变量声明/初始化逻辑迁移到 Builder。
3. **Validator**：将前置条件/约束校验迁移到 Validator。
4. **Aggregate**：将核心业务逻辑迁移到 Aggregate。
5. **OutService**：将跨包调用封装为 OutService。
6. **Processor**：编排整体流程，处理事务和异常。
7. **Access**：定义对外接口。
8. **测试**：编写单元测试验证等价性。

## 十三、常见陷阱与注意事项

1. 【强制】OUT 参数遗漏：存储过程的所有 OUT 参数必须在 Builder 中预定义。
2. 【强制】异常截断：错误信息超过 1000 字符需截断，避免数据库字段溢出。
3. 【强制】事务边界：Processor 层不控制事务，由 Aggregate 层标注 `@Transactional`。
4. 【强制】批量更新：超过 1000 条记录必须分批处理。
5. 【强制】字典转换：字典值转换逻辑放在 Builder 中，不在 Validator 中。
6. 【强制】日期格式：统一在 Builder 中转换日期格式。
7. 【强制】空值处理：所有可能为空的字段必须设置默认值。
8. 【强制】日志记录：每个关键步骤必须记录日志，便于问题排查。

---

## 【强制】Java 版本与框架配置（唯一事实来源）

> **此段落是所有版本和框架决策的唯一权威来源。plan.json 的 javaVersion / springBootVersion、
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
