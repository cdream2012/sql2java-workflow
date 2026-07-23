# Project Spec — test-gen 子阶段（单元测试 + Mapper 集成测试）

> 本规约由引擎注入 translate-test 子 agent 系统提示词。融合自《单元测试生成规约（行覆盖率导向）》，已适配本工作流 per-proc 架构与 H2 测试配置。

## 一、核心原则

- **唯一目标：行覆盖率 ≥ 90%**（建议 95%）。不关心业务逻辑正确性、断言合理性，只关心每一行都被执行到。
- **万物皆可 Mock**：任何依赖、方法、异常都可 Mock。
- 一个测试函数一个断言即可，简单断言最好（`assertNotNull(response)`）。

## 二、测试文件位置与命名

- 目录（无根包，按角色顶层包）：ServiceImpl 单元测试落 `{projectRoot}/src/test/java/service/impl/`，Mapper 集成测试落 `{projectRoot}/src/test/java/mapper/`。
- 单元测试类名：`{className}{业务实现后缀}Test`（`className` 查 `scaffold.json.generated.procClassNames`，如 `GetTrdDtl` → `GetTrdDtlServiceImplTest`）。
- Mapper 集成测试类名：`{className}MapperIntegrationTest`。

## 三、单元测试类骨架

```java
@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
public class XxxServiceImplTest {
    @Mock private XxxMapper xxxMapper;
    @Mock private LogUtil logUtil;          // 日志类也 Mock（触达外层 catch 用）
    @InjectMocks private XxxServiceImpl xxxService;
    private XxxRequest request;

    @BeforeEach
    public void setUp() { request = new XxxRequest(); }
}
```

- JUnit 5 + Mockito + PowerMock（反射）；**禁止 `@SpringBootTest`**（除非必要）。
- 用 JUnit 5 `Assertions`，禁止 JUnit 4 `Assert`。

## 四、Mock 策略

- 所有外部依赖必须 Mock：Mapper（数据库）、Service（其他服务）、Client（外部调用）、LogUtil（日志）、任何可能抛异常的对象。
- 返回空值触发空指针保护、返回单值触发正常流程、返回多值触发循环、`thenThrow` 触发 catch 分支、多次调用 `thenReturn(...).thenReturn(...).thenThrow(...)` 返回不同值。
- **Mock 日志类触达外层 catch**：内层 catch 捕获 Mapper 异常后调 `logUtil.error()`，若再 mock `logUtil.error()` 抛异常，新异常传播到外层 catch，覆盖目标行。
- `thenThrow` 用普通异常（`RuntimeException`/`IllegalArgumentException`），**禁止** `OutOfMemoryError`/`StackOverflowError`。

## 五、单函数多覆盖（首选策略）

**在一个测试函数中覆盖连续多行代码**——减少测试数量（50+ → 10~15 个），复用 Mock 对象，每次调用只改关键参数覆盖不同分支。

适用：连续 if/else-if、switch/case、同逻辑不同参数组合、连续代码行。不适用：复杂独立业务逻辑、需详细断言场景、异常处理分支（建议单独测试）。

```java
@Test
public void test_Line245_315_MultiCoverage() {
    // ===== 第1次：覆盖 245-248 行（feeType=42）=====
    when(mapper.selectByCondition(any())).thenReturn(mockData);
    Response r = service.method(request);
    Assertions.assertNotNull(r);

    // ===== 第2次：覆盖 250-262 行（feeType=43, ccy1Amt>0）=====
    mockData.setFeeType("43");
    r = service.method(request);
    Assertions.assertNotNull(r);
    // ... 继续覆盖更多分支
}
```

关键：复用 Mock 不重复 `when`、重复调用被测方法、最小断言 `assertNotNull`、注释标明覆盖行范围。

## 六、覆盖所有代码结构

- **if/else**：单函数多覆盖（同函数 if 真/假两次调用）或独立测试函数。
- **try/catch**：try 正常 + catch 异常，`doThrow` 触发 catch。
- **switch/case**：每个 case + default，`assertDoesNotThrow`。

## 七、反射（私有方法/字段）

```java
import org.powermock.reflect.Whitebox;
String r = (String) Whitebox.invokeMethod(xxxService, "privateMethod", data);
Whitebox.setInternalState(xxxService, "initialized", true);
```

## 八、Mapper 集成测试

```java
@MybatisTest
@AutoConfigureTestDatabase(replace = Replace.NONE)
@Sql("classpath:schema-h2.sql")
class XxxMapperIntegrationTest {
    @Autowired private XxxMapper xxxMapper;
}
```

- H2 建表脚本用 scaffold 的 `schema-h2.sql`。
- H2 不兼容的 SQL → 修复测试数据准备 SQL 或标 `@Disabled`（不计入覆盖率）。
- 缺表/列 → 从 `inventory.json` 补全 schema-h2.sql（**追加**到文件末尾，不修改已有表定义）。

## 九、断言要求

最低：每个测试至少一个断言。`assertNotNull(response)` / `assertDoesNotThrow(...)` / `assertNotNull(response.getFlag())`。

## 十、常见问题

- **Mockito 严格模式报错**：加 `@MockitoSettings(strictness = Strictness.LENIENT)`。
- **参数匹配器错误**：禁混用匹配器与具体值——`when(mapper.select("id", anyString()))` ❌；全用匹配器 `when(mapper.select(eq("id"), anyString()))` ✅。
- **NPE**：检查每个 `@Mock` 配置、`@InjectMocks` 注入关系。

## 十一、检查清单

- [ ] 测试文件位于 `src/test/java` 正确位置，类名 = 源码类名 + Test
- [ ] Mock 所有外部依赖（Mapper/Service/LogUtil）
- [ ] 优先单函数多覆盖模式
- [ ] 每个 if/else、try/catch、switch/case 分支都有测试
- [ ] 所有测试可编译、可运行
- [ ] 行覆盖率 ≥ 90%
- [ ] 测试函数数量合理（10~15，非 50+）
- [ ] 未改翻译产物（只读 Java，写测试）；未改已有测试
