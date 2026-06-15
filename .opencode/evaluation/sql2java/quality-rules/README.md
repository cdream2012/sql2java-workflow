# Checkstyle 规则说明

> 映射 `.opencode/docs/java-code-spec.md` 中的【强制】条款，用于 L2 评估阶段的确定性规约检查。
>
> 使用方式：`mvn checkstyle:check -Dcheckstyle.config.location=checkstyle.xml`

## 规则来源标注格式

每条规则的 `message` 中标注了来源，格式为 `java-code-spec X.Y`：

- `X` = 章节编号：`(一)` 命名 ~ `(八)` 注释
- `Y` = 条款编号
- `Java8-N` = Java 8 合规检查第 N 条（对应 java-code-spec 中"禁止的 Java 9+ 语法和 API"段落）

## 规则清单

### (一) 命名风格

| 条款 | 规则 | Checkstyle 模块 | 严重级别 | 说明 |
|------|------|----------------|---------|------|
| 一.1 | 命名禁止下划线/美元符号相邻 | `RegexpSinglelineJava` | warning | 检测 `$_` 或 `_$` 模式 |
| 一.3 | 类名 UpperCamelCase | `TypeName` | warning | 允许 DO/DTO/VO/Impl/Service 等后缀 |
| 一.4 | 方法名 lowerCamelCase | `MethodName` | warning | — |
| 一.4 | 参数名 lowerCamelCase | `ParameterName` | warning | — |
| 一.4 | 成员变量 lowerCamelCase | `MemberName` | warning | — |
| 一.4 | 局部变量 lowerCamelCase | `LocalVariableName` | warning | — |
| 一.5 | 常量全大写下划线 | `ConstantName` | warning | 允许 `log`/`logger` 例外 |
| 一.6 | 抽象类 Abstract/Base 开头 | `AbstractClassName` | warning | — |
| 一.8 | POJO 布尔属性无 is 前缀 | `RegexpSinglelineJava` | warning | 检测 `private boolean isXxx` 模式 |
| 一.9 | 包名全小写 | `PackageName` | warning | 点分隔每段仅小写字母+数字 |

### (二) 常量定义

| 条款 | 规则 | Checkstyle 模块 | 严重级别 | 说明 |
|------|------|----------------|---------|------|
| 二.2 | long 赋值用大写 L | `RegexpSinglelineJava` | warning | 检测 `123l` 模式（小写 l） |

### (三) 代码格式

| 条款 | 规则 | Checkstyle 模块 | 严重级别 | 说明 |
|------|------|----------------|---------|------|
| 三.2 | 括号内无空格 | `ParenPad` | warning | `(x)` 正确，`( x )` 错误 |
| 三.3 | 逗号/分号后加空格 | `WhitespaceAfter` | warning | — |
| 三.4 | 运算符两侧加空格 | `WhitespaceAround` | warning | 覆盖赋值、算术、逻辑、比较等运算符 |
| 三.5 | 4 空格缩进 | `Indentation` | warning | basicOffset=4, caseIndent=4, throwsIndent=8 |
| 三.5 | 禁止 tab 字符 | `RegexpSinglelineJava` | warning | 检测行首 `\t` |
| 三.6 | 双斜杠与注释间一个空格 | `RegexpSinglelineJava` | warning | 检测 `//xxx` 模式（无空格） |
| 三.8 | 行宽不超过 120 | `LineLength` | warning | 忽略 import、URL、@see |
| 三.10 | Unix 换行符 (LF) | `NewlineAtEndOfFile` | warning | — |

### (四) OOP 规约

| 条款 | 规则 | Checkstyle 模块 | 严重级别 | 说明 |
|------|------|----------------|---------|------|
| 四.2 | 覆写方法必须 @Override | `MissingOverride` | warning | — |
| 四.10 | 禁止 BigDecimal(double) | `RegexpSinglelineJava` | warning | 检测 `new BigDecimal(1.23)` 模式 |

### (五) 集合与异常

| 条款 | 规则 | Checkstyle 模块 | 严重级别 | 说明 |
|------|------|----------------|---------|------|
| 五.异常 | 禁止空 catch 块 | `EmptyCatchBlock` | warning | 允许变量名为 `expected`/`ignore`/`ignored` |

### Java 8 合规检查

对应 java-code-spec 中"禁止的 Java 9+ 语法和 API"段落的 12 条规则。

| 编号 | 禁止项 | 检测模式 | 替代方案 |
|------|--------|---------|---------|
| Java8-1 | `var` 关键字 (Java 10+) | `^\s*var\s+\w+\s*=` | 显式声明类型 |
| Java8-2 | `List.of/Map.of/Set.of` (Java 9+) | `\b(List\|Map\|Set)\.of\s*\(` | `Arrays.asList()` / `Collections.unmodifiableList()` |
| Java8-3 | `Optional` 9+ 方法 | `.ifPresentOrElse()` / `.or()` / `.stream()` | Java 8 Optional API |
| Java8-4 | `Stream` 9+ 方法 | `.takeWhile()` / `.dropWhile()` / `Stream.ofNullable()` | Java 8 Stream API |
| Java8-5 | `String` 11+ 方法 | `.isBlank()` / `.strip()` / `.lines()` / `.repeat()` | `trim()` + 自行实现 |
| Java8-6 | `HttpClient` API (Java 11+) | `HttpClient` / `HttpRequest` / `HttpResponse` | `HttpURLConnection` 或第三方库 |
| Java8-10 | `switch` 箭头表达式 (Java 12+) | `case ... ->` | 传统 `switch` + `case: break` |

### (八) 注释规约

| 条款 | 规则 | Checkstyle 模块 | 严重级别 | 说明 |
|------|------|----------------|---------|------|
| 八.注释 | 禁止英文注释 | `RegexpSinglelineJava` | warning | 近似检测：连续 3+ 个英文单词且无中文字符的 `//` 注释 |
| 八.Javadoc | Javadoc 格式 | `JavadocStyle` | warning | 不检查首句、不检查空 Javadoc、不检查 HTML |

## Checkstyle 无法覆盖的【强制】条款

以下条款由于 Checkstyle 的能力限制，无法自动检测，留给 review 阶段的 LLM 审查：

| 条款 | 规则 | 原因 |
|------|------|------|
| 一.2 | 禁止拼音英文混合命名 | 需要语义理解 |
| 一.10 | 避免父子类同名变量 | 需要跨类分析 |
| 一.11 | 杜绝不规范缩写 | 需要语义理解 |
| 二.1 | 禁止魔法值 | 需要上下文判断（`0`、`1` 等是否属于魔法值） |
| 三.11 | 单方法不超过 80 行 | 可用 MethodLength 模块补充，当前未启用 |
| 四.14 | 构造方法禁止业务逻辑 | 需要语义理解 |
| 五.集合 | entrySet 遍历（非 keySet） | 需要数据流分析 |
| 八.注释 | @author/@date 格式 | 可用 JavadocMethod 模块补充，当前未启用 |

## 评分计算

L2 评估中 `score.style` 的计算方式：

```
score.style = max(0, (1 - violations / javaLoc) * 100)
```

- `violations`：Checkstyle 输出的 `[WARN]` + `[ERROR]` 总行数
- `javaLoc`：Java 源码总行数
- 违规率越低，得分越接近 100

## 自定义与扩展

- **调整规则**：直接修改 `checkstyle.xml`，无需改动其他文件
- **新增规则**：参考 [Checkstyle 官方配置文档](https://checkstyle.org/config.html) 添加 `<module>` 节点
- **排除文件**：在 `<module name="Checker">` 下添加 `<module name="SuppressionFilter">` 并指定排除文件
- **调整严重级别**：修改 `<property name="severity" value="..."/>` ，可选 `error` / `warning` / `info`
