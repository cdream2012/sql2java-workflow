# L3 语义分析测量用例说明

> 定义每个子程序的**预期结构特征**，评估时与实际翻译产出逐项比对。
> 与 L4 equivalence-cases 的区别：L3 检查翻译的**结构完整性**，L4 检查翻译的**行为正确性**。

## 使用方式

```bash
# 默认包含 L3 层
/sql2java_evaluation
# 或显式指定
/sql2java_evaluation --layers l3
```

评估 agent 读取本目录下的 YAML 文件，逐用例执行：
1. 从 `source_file` 中定位子程序的 PL/SQL 代码范围
2. 统计该范围内的 SQL/表/控制流/异常 → `actual_plsql`
3. 从 Java 产出中定位对应的翻译方法
4. 统计 Java 方法的 SQL/表/控制流/异常 → `actual_java`
5. 逐项比对 `actual_plsql` vs `expected` → 标记 pass/fail
6. 逐项比对 `actual_java` vs `expected` → 标记 pass/fail
7. 检查 `special_constructs`（如有） → 标记 pass/fail

结果写入 `{reportDir}/l3-summary.json` 的 `measurementCases` 字段。

## 用例总览

| 文件 | 子程序 | 预期 SQL | 预期表 | 预期控制流 | 关键 special_constructs |
|------|--------|---------|--------|-----------|------------------------|
| `fn_abc_class.yaml` | fn_abc_class | 无 | 无 | if:3, return:4 | — |
| `core_pkg_log_error.yaml` | log_error | INSERT:1 | t_error_log | if:1 | PRAGMA AUTONOMOUS → REQUIRES_NEW |
| `core_pkg_get_item.yaml` | get_item | SELECT:1 | t_item | return:1 | %ROWTYPE → Entity |
| `core_pkg_get_item_obj.yaml` | get_item_obj | 无 | 无 | return:2, case:1 | CASE 分派 → 工厂方法 |
| `core_pkg_create_item.yaml` | create_item ×2 | INSERT:2 | t_item | — | 重载 + RETURNING INTO |
| `core_pkg_get_bom_components.yaml` | get_bom_components | SELECT:1 | t_bom_line, t_item | return:1 | BULK COLLECT → List |
| `core_pkg_explode_bom.yaml` | explode_bom | SELECT:1 | t_bom_line, t_bom_header, t_item | loop:1, return:1 | PIPELINED → List |
| `core_pkg_list_bom.yaml` | list_bom | SELECT:1 | t_bom_line, t_bom_header, t_item | — | CONNECT BY → 递归 |
| `core_pkg_bom_cost.yaml` | bom_cost | SELECT:2 | t_item, t_bom_line, t_bom_header | loop:1, return:2 | 递归函数 |
| `core_pkg_bulk_receive.yaml` | bulk_receive | INSERT:1, MERGE:1 | t_inventory_txn, t_item | if:1, loop:2 | FORALL → batch + MERGE |
| `core_pkg_issue_fifo.yaml` | issue_fifo | SELECT:1, UPDATE:1 | t_inventory_lot | loop:1 | WHERE CURRENT OF → 按主键更新 |
| `core_pkg_archive_before.yaml` | archive_before | DELETE:1 | t_inventory_txn | — | EXECUTE IMMEDIATE → JdbcTemplate |
| `trg_item_audit.yaml` | trg_item_audit | INSERT:1 | t_error_log | — | 触发器 → AOP/Interceptor |

## YAML 格式说明

```yaml
# 子程序标识
subprogram: <子程序名>
source_file: <PL/SQL 源文件相对路径>
description: <子程序描述>

# 预期结构特征
expected:
  # SQL 语句计数（按类型）
  sql_statements:
    select: <int>
    insert: <int>
    update: <int>
    delete: <int>
    merge: <int>

  # 引用的表名列表
  tables:
    - <table_name>

  # 控制流计数
  control_flow:
    if: <int>       # IF / ELSIF / CASE WHEN
    loop: <int>     # FOR / WHILE / LOOP
    return: <int>   # RETURN 语句
    case: <int>     # CASE 表达式（可选）

  # 异常映射（每条定义 PL/SQL 异常 → 期望 Java 异常）
  exceptions:
    - plsql: "<PL/SQL 异常子句>"
      expected_java: "<Java 异常类型>"
      severity: critical | major | minor
      note: "<说明>"

  # 类型映射（每条定义参数/返回值 → 期望 Java 类型）
  type_mappings:
    - param: <参数名>          # 或 return: true
      oracle_type: <Oracle 类型>
      expected_java_type: <Java 类型>

  # 特殊构造（PL/SQL 特有语法 → 期望 Java 翻译方式）
  special_constructs:
    - construct: "<PL/SQL 构造描述>"
      expected_java: "<期望的 Java 翻译>"
      severity: critical | major | minor
      note: "<说明>"
```

## 严重级别定义

| 级别 | 定义 | 比对失败时影响 |
|------|------|---------------|
| **critical** | 必须正确翻译的核心构造 | 该用例标记 failed，影响 L3 总分 |
| **major** | 应该正确翻译的重要构造 | 该用例标记 failed，但权重较低 |
| **minor** | 建议正确翻译的辅助构造 | 仅记录为 suggestion，不影响评分 |

## 各用例详细说明

### fn_abc_class.yaml

**子程序**：`fn_abc_class(p_cum_pct, p_a_pct DEFAULT 0.80, p_b_pct DEFAULT 0.95) RETURN VARCHAR2`

```
IF p_cum_pct IS NULL  →  RETURN NULL
IF <= p_a_pct         →  RETURN 'A'
ELSIF <= p_b_pct      →  RETURN 'B'
ELSE                  →  RETURN 'C'
```

- 无 SQL、无表、无异常
- 3 个 if（IS NULL / <= / ELSIF <=）、4 个 return
- 纯计算函数，翻译为静态工具方法

### core_pkg_log_error.yaml

**关键构造**：`PRAGMA AUTONOMOUS_TRANSACTION`

- 1 条 INSERT（写 t_error_log）
- 1 个 if（IF g_debug_on）
- WHEN OTHERS → catch(Exception) 容错处理
- **critical**：自治事务必须映射为 `@Transactional(REQUIRES_NEW)`

### core_pkg_get_item.yaml

**关键构造**：`SELECT * INTO v FROM t_item` + `EXCEPTION WHEN NO_DATA_FOUND`

- 1 条 SELECT
- 1 个 return
- NO_DATA_FOUND → EmptyResultDataAccessException
- RAISE_APPLICATION_ERROR(-20101) → BizException
- **critical**：`%ROWTYPE` 必须映射为 Entity 类

### core_pkg_get_item_obj.yaml

**关键构造**：`CASE v.item_type WHEN 'RAW' THEN t_raw_material_obj(...)`

- 无直接 SQL（内部调用 get_item）
- 1 个 case + 2 个 return
- **critical**：CASE 分派必须翻译为工厂方法 + 子类实例化

### core_pkg_create_item.yaml

**关键构造**：两个重载过程 + `RETURNING INTO`

- 2 条 INSERT（两个重载版本）
- **critical**：过程重载必须翻译为 Java 方法重载
- **critical**：`RETURNING INTO` 必须映射为 useGeneratedKeys

### core_pkg_get_bom_components.yaml

**关键构造**：`BULK COLLECT INTO` 对象集合

- 1 条 SELECT（JOIN t_bom_line + t_item）
- 1 个 return
- **critical**：`BULK COLLECT INTO` → `Mapper.selectList → List<BomCompObj>`

### core_pkg_explode_bom.yaml

**关键构造**：`PIPELINED` + `PIPE ROW`

- 1 条 SELECT（3 表 JOIN + status 过滤）
- 1 个 loop + 1 个 return
- **critical**：PIPELINED → 普通 List 返回，PIPE ROW → list.add()

### core_pkg_list_bom.yaml

**关键构造**：`CONNECT BY NOCYCLE PRIOR` + `SYS_REFCURSOR`

- 1 条 SELECT（层次查询）
- **critical**：CONNECT BY → 递归 SQL 或 Java 递归
- **critical**：SYS_REFCURSOR OUT → List 返回

### core_pkg_bom_cost.yaml

**关键构造**：递归 PL/SQL 函数（bom_cost 调用 bom_cost）

- 2 条 SELECT（查 std_cost + 遍历子件）
- 1 个 loop + 2 个 return
- NO_DATA_FOUND → return 0（不是抛异常）
- **critical**：递归函数必须翻译为递归 Java 方法

### core_pkg_bulk_receive.yaml

**关键构造**：`FORALL SAVE EXCEPTIONS` + `MERGE INTO`

- 1 条 INSERT + 1 条 MERGE
- 1 个 if（SQLCODE 判断）+ 2 个 loop
- **critical**：FORALL → batch executor，不能逐条循环 + 吞异常
- **critical**：MERGE INTO → insertOrUpdate

### core_pkg_issue_fifo.yaml

**关键构造**：窗口函数 + `WHERE CURRENT OF`

- 1 条 SELECT（FOR UPDATE）+ 1 条 UPDATE
- 1 个 loop
- **critical**：WHERE CURRENT OF → 按主键更新（Java 无等价语法）
- **critical**：FIFO 顺序和逐批扣减语义必须保留

### core_pkg_archive_before.yaml

**关键构造**：`EXECUTE IMMEDIATE` 动态 SQL

- 1 条 DELETE（动态）
- **critical**：EXECUTE IMMEDIATE + USING → JdbcTemplate.update + 绑定变量
- **critical**：SQL%ROWCOUNT → update 返回 int

### trg_item_audit.yaml

**关键构造**：`AFTER UPDATE OF` + `WHEN (old <> new)` + `:old/:new`

- 1 条 INSERT（写审计日志）
- **critical**：触发器 → AOP 拦截指定方法
- **critical**：WHEN 条件 → 比较新旧值，仅变化时写审计

## 评分计算

L3 评估中 `measurementCases` 对总分的影响：

```
每个用例得分 = (通过的 critical 数 + 0.5 × 通过的 major 数) /
               (总 critical 数 + 0.5 × 总 major 数)

measurementCasesScore = avg(各用例得分) × 100
```

此分数作为 L3 总分的补充维度，写入 `l3-summary.json`。
