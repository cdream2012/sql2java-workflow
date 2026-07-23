# Project Spec — translate-core 子阶段（TODO 桩 → 真实翻译）

> 本规约由引擎注入 translate-core 子 agent 系统提示词。融合自《待办逻辑填充详细设计生成规约》《待办逻辑填充详细设计检查规约》，已适配本工作流 per-proc 架构。原 skill 调用（ddl-to-entity/package-lookup/child-code-index-lookup）与设计文档路径已删除/映射。

## 一、核心目标

严格对应 skeleton 留下的 `// TODO: [translate]` 桩逐一翻译——**翻译一个删除一个 TODO 标记**，保证转译后文件无 TODO 残留（lint 子阶段会核对）。不确定项由 LLM 给出最佳翻译，**不留 TODO**；真正无法确定的写中文注释说明，交 review/fix。

## 二、只增不删不覆盖

- 已存在文件（含 skeleton 产出的桩文件）用 `edit` 替换桩体，**不覆盖整文件**。
- 跨包/同包跨单元调用走「依赖签名」预注入块，**禁止 read `translations/`**，禁止改其他 unit 产物。
- 复用已有 Mapper 方法：仅当查询字段/WHERE 条件/固定值/可选参**完全一致**才复用；否则在接口与 XML **末尾追加新方法**，不修改/删除已有方法。

## 三、DO 对象设计

| 类型 | 识别特征 | 处理 |
|---|---|---|
| 自定义 DO | 联表 JOIN 查询 或 计算字段（如 `amount * rate`） | 个性化设计：业务前缀（`{业务前缀}{功能}DO`，如 `FxTradeQueryDO`）+ `resultMap` 映射驼峰↔下划线；计算字段用 SQL `AS 别名` + resultMap 映射 |
| 标准 DO | 单表查询（`SELECT *` 或部分字段），无联表无计算 | 复用 scaffold 全局 DO（DDL 字段固定，Java 中只用需要的字段即可，无需新建） |

- DO 字段必须与 inventory/schema 一致，**禁止编造**；发现不一致立即修复或标 TODO。
- **禁止为图新程序方便而修改已有 DO**——新程序通过新 DTO 或 Map 适配。

## 四、Mapper XML 规范

1. **禁止 `SELECT *`**——必须明确列出所有字段。
2. **表名用 `schema.tableName`** 格式（schema 从 inventory/scaffold 取，禁凭空猜测）。
3. **比较符号 XML 转义或 CDATA**：`<`→`&lt;`（或 `<![CDATA[<]]>`）、`>`→`&gt;`（或 `<![CDATA[>]]>`）、`<=`→`&lt;=`（或 `<![CDATA[<=]]>`）、`>=`→`&gt;=`（或 `<![CDATA[>=]]>`）、`&`→`&amp;`。两者皆可，整段复杂条件推荐 CDATA。
4. **占位符用 `#{}`**（禁 `${}`），namespace 对应 Mapper 接口全限定名。
5. **禁止 Mapper XML 调用存储过程**（去存储过程化目标）：XML 只查原始字段；存储过程调用改为 Java Service 层调已转换的 Service 方法，结果 set 回 DTO。
6. **SQL 与函数定义一致**：Mapper XML 中 SQL 必须与 `shard-inputs/{pkg}/{ref}/source.sql` 函数定义逐行一致，禁私自优化/简化/改写（WHERE 条件、子查询结构、固定值）。

```xml
<!-- ❌ 错：XML 中调存储过程 -->
{schema}.{pkg}.{func}(t1.{col}, 'p', #{id}) AS {calcCol}
<!-- ✅ 对：只查原始字段，Java 层调已转方法 -->
t1.{col} AS {col}
```

## 五、序列号处理

| 场景 | 处理 |
|---|---|
| INSERT | VALUES 中直接用 `seq_xxx.NEXTVAL` |
| SELECT 查序列 | 单独 `selectNextval()` 方法查询，禁在业务查询 SQL 中直接 NEXTVAL（浪费序列号）；GaussDB 虚拟表写 `SELECT seq_xxx.NEXTVAL FROM sys_dummy` |

## 六、BigDecimal 除法（硬规则）

- 所有 `BigDecimal.divide()` **必须指定舍入模式与精度**：`divide(divisor, 10, RoundingMode.DOWN)`（截断，保留 10 位小数）。
- ❌ 禁止无舍入模式除法（`ArithmeticException` 风险）。
- 适用所有除法（金额计算、汇率换算、比例计算）。

```java
// ❌ 错
BigDecimal r = amount.multiply(price).divide(new BigDecimal("100"));
// ✅ 对
BigDecimal r = amount.multiply(price).divide(new BigDecimal("100"), 10, RoundingMode.DOWN);
```

## 七、异常处理（硬规则）

1. **禁止 `throw`/`throws`**：方法签名不得有 `throws`，方法体不得 `throw`，catch 中不得 `throw e` 或包装抛出。
2. **每个可能异常的存过/函数在方法内 try-catch 自处理**：catch 中仅记日志 + 设置错误响应（`flag=1, msg=e.getMessage()`），返回响应对象。
3. **SELECT INTO 空值 + `EXCEPTION WHEN no_data_found`**：查询结果为空会抛 `no_data_found`，Java 中判空后用 `Validate.notNull(xxx, "no_data_found")`——**唯一可外抛的例外**；其余异常一律不外抛。
4. **try-catch 开头规则**：伪代码/翻译无需 try-catch 开头，除非存过 SQL 是 `BEGIN` 开头。
5. **LogUtil 必须注入非静态**：日志统一用注入的 `log`（`log.error(...)`），禁止静态 `LogUtil` 调用、禁止私自 new 静态 LogUtil。

```java
// ✅ 正确：仅记日志返回错误
public Response myMethod(Request request) {
    Response response = new Response();
    response.setFlag(0);
    try {
        // 业务逻辑
        response.setMsg("处理成功");
    } catch (Exception e) {
        log.error("myMethod 异常，参数：{}", JSON.toJSONString(request), e);
        response.setFlag(1);
        response.setMsg(e.getMessage());  // 不 throw
    }
    return response;
}
```

## 八、函数调用失败处理

- **严格对照 SQL 定义文件实际行为**：若 SQL 中某函数调用失败后**没有 RETURN 结束函数**，Java 中**绝对不可**擅自加 `return response;` 提前返回。
- 调用失败后 SQL 若继续执行后续逻辑，Java 也必须继续；唯一例外是 SQL 明确用 RETURN 结束。

## 九、变量来源

- 未识别变量（常量/配置值）：查包头/SQL 目录声明，**禁止凭经验硬编码编造**。
- 非局部变量声明在主函数顶层，作用域覆盖整个主函数。
- 跨包变量（`{schema}.{变量名}`）查依赖签名块/上游 artifact 推导来源。

## 十、翻译忠实度

- 严格匹配 SQL 原始逻辑：`nvl(a,b)`→`a != null ? a : b`、`nvl2(a,b,c)`→`a != null ? b : c`、`decode(a,v1,r1,v2,r2,default)`→`switch/if-else`；分支条件/循环边界/赋值顺序保持一致。
- **复用节点调用标注**：调用跨包/已转方法处加注释 `// ★ 复用节点调用：{子函数名}（原始 SQL 行号：XX）`，含 Java 方法名 + 文件路径来源。
- `if-else-if` 必须形成连续链式结构，不可拆分。
- 不随意加 `LIMIT 1`（除非原 SQL 已有一行限制）。
- 分立 SELECT 保持独立调用（不合并）；游标循环用 for-each（不优化为 stream）。

## 十一、自检清单

- [ ] 文件无 `// TODO: [translate]` 残留
- [ ] DO 分类正确，字段与 inventory 一致，未编造
- [ ] Mapper XML 无 `SELECT *`、表名带 schema、比较符号已转义或 CDATA、未调存储过程
- [ ] Mapper XML SQL 与 source.sql 函数定义逐行一致，未优化
- [ ] 所有 BigDecimal 除法带 `(, 10, RoundingMode.DOWN)`
- [ ] 无 `throw`/`throws`，异常方法内自处理；no_data_found 用 Validate.notNull
- [ ] 日志用注入 `log`，无静态 LogUtil
- [ ] 序列号 SELECT 用单独方法（GaussDB `FROM sys_dummy`）
- [ ] 未擅自加提前 return（对照 SQL）
- [ ] 未识别变量已查来源，未硬编码
- [ ] 翻译忠实 SQL（nvl/decode/分支/循环），if-else-if 链式
