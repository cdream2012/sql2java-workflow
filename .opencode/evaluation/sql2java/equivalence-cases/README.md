# L4 行为等价测试用例说明

> 验证 PL/SQL → Java 翻译的**行为等价性**：给两端相同的输入，对比输出是否一致。
>
> 数据库环境：PostgreSQL（通过 orafce 扩展或手动适配 Oracle 语法）

## 使用方式

```bash
# 在 /sql2java_evaluation 中指定 L4 层
/sql2java_evaluation --layers l1,l2,l3,l4
```

评估 agent 读取本目录下的 YAML 文件，逐用例执行：
1. 在 PostgreSQL 中执行 `setup.sql` 初始化数据
2. 执行 `pg_call` 获取数据库端结果
3. 通过 JUnit 执行 `java_call` 获取 Java 端结果
4. 宽容比对（BigDecimal 忽略 scale、NULL≈空串、浮点容忍 0.0001）
5. 结果写入 `{reportDir}/l4-summary.json`

## 用例总览

| 文件 | 子程序 | 难度 | 用例数 | 测试的 PL/SQL 构造 | 期望 Java 映射 |
|------|--------|------|--------|-------------------|---------------|
| `fn_abc_class.yaml` | fn_abc_class | P0 | 8 | DETERMINISTIC 纯函数、IF/ELSIF/ELSE | 静态工具方法 |
| `core_pkg_log_error.yaml` | log_error | P1 | 3 | PRAGMA AUTONOMOUS_TRANSACTION | `@Transactional(REQUIRES_NEW)` |
| `core_pkg_get_item.yaml` | get_item | P1 | 3 | SELECT INTO、%ROWTYPE、NO_DATA_FOUND | Mapper.selectById → Entity |
| `core_pkg_get_item_obj.yaml` | get_item_obj | P2 | 3 | 多态 CASE 分派、对象构造器调用 | 工厂方法 + 子类实例化 |
| `core_pkg_create_item.yaml` | create_item ×2 | P1 | 3 | 重载、RETURNING INTO、NVL、OUT 参数 | 重载方法 + useGeneratedKeys |
| `core_pkg_get_bom_components.yaml` | get_bom_components | P1 | 2 | BULK COLLECT INTO 对象集合 | Mapper.selectList → List |
| `core_pkg_explode_bom.yaml` | explode_bom | P2 | 3 | PIPELINED + PIPE ROW | 普通方法返回 List |
| `core_pkg_list_bom.yaml` | list_bom | P2 | 3 | CONNECT BY + SYS_REFCURSOR | 递归查询或 Java 递归 |
| `core_pkg_bom_cost.yaml` | bom_cost | P2 | 3 | 递归 PL/SQL 函数 | 递归 Java 方法 |
| `core_pkg_bulk_receive.yaml` | bulk_receive | P2 | 3 | FORALL SAVE EXCEPTIONS + MERGE INTO | batch executor + insertOrUpdate |
| `core_pkg_issue_fifo.yaml` | issue_fifo | P2 | 4 | 窗口函数 + WHERE CURRENT OF | 查批次 List + 逐批更新 |
| `core_pkg_archive_before.yaml` | archive_before | P2 | 3 | EXECUTE IMMEDIATE + SQL%ROWCOUNT | JdbcTemplate.update → int |
| `trg_item_audit.yaml` | trg_item_audit | P1 | 4 | AFTER UPDATE OF + WHEN + :old/:new | AOP 拦截或 MyBatis Interceptor |

**合计：42 个测试用例**（P0: 8 / P1: 16 / P2: 18）

## YAML 格式说明

```yaml
# 测试套件标识
test_suite: <子程序名>
description: <测试描述>
source_file: <PL/SQL 源文件相对路径>
java_class: <Java 类全限定名>
java_method: <Java 方法名>

# 数据初始化（每个用例执行前运行）
setup:
  sql: |
    <PostgreSQL DDL/DML>

# 测试用例列表
cases:
  - name: <用例名称>
    description: |
      <用例说明：PL/SQL 原始行为 → 期望 Java 行为>
    pg_call: <PostgreSQL 调用语句>
    java_call: <Java 调用代码片段>
    expected_return: <期望返回值>          # 简单返回值时用
    expected:                              # 复杂预期时用
      return_type: <Java 返回类型>
      return_size: <List 大小>
      return_fields:                       # 返回对象的字段值
        field_name: value
      t_表名:                              # 数据库表状态变化
        count_delta: +1 / -1 / 0          # 行数变化
        new_row_match:                     # 新增行的字段匹配
          field: value
      exception: <异常类名>                # 期望抛出的异常
      error_code_contains: <错误码片段>
    tolerance: <浮点数容差>                # 可选，默认 0.0001
```

## 各用例详细说明

### fn_abc_class.yaml（P0 基础）

**测试目标**：验证 DETERMINISTIC 纯函数的翻译正确性。

| 用例 | 输入 | 预期 | 验证要点 |
|------|------|------|---------|
| A类_cumPct低于80% | 0.50 | "A" | 基本 IF 分支 |
| B类_cumPct在80%-95%之间 | 0.88 | "B" | ELSIF 分支 |
| C类_cumPct高于95% | 0.98 | "C" | ELSE 分支 |
| NULL输入返回NULL | null | null | NULL 处理 |
| 边界值_刚好80%归A | 0.80 | "A" | <= 边界 |
| 边界值_刚好95%归B | 0.95 | "B" | <= 边界 |
| 零值归A | 0 | "A" | 极小值 |
| 自定义阈值 | 0.70, 0.70, 0.90 | "A" | 带默认值参数的重载 |

### core_pkg_log_error.yaml（P1 中等）

**测试目标**：验证自治事务的翻译正确性。

| 用例 | 验证要点 |
|------|---------|
| 正常记录错误日志 | INSERT 写入 t_error_log，字段值正确 |
| 超长错误消息截断到2000 | SUBSTR(p_error_msg, 1, 2000) → 截断逻辑 |
| 独立事务提交 | 外层回滚后日志行仍存在（REQUIRES_NEW） |

### core_pkg_get_item.yaml（P1 中等）

**测试目标**：验证 SELECT INTO + 异常映射。

| 用例 | 验证要点 |
|------|---------|
| 正常查询 | SELECT * INTO → Mapper.selectById → ItemDO，全部字段正确 |
| 不存在时抛异常 | NO_DATA_FOUND → RAISE_APPLICATION_ERROR(-20101) → BizException |
| 查询另一条 | 不同数据行的字段值正确 |

### core_pkg_get_item_obj.yaml（P2 高难）

**测试目标**：验证多态对象构造的翻译正确性。

| 用例 | 验证要点 |
|------|---------|
| RAW类型返回RawMaterialObj | CASE 'RAW' → new RawMaterialObj(...)，字段值正确 |
| FG类型返回null | CASE ELSE → return null |
| 不存在时抛异常 | 内部调用 get_item 传播 BizException |

### core_pkg_create_item.yaml（P1 中等）

**测试目标**：验证重载过程和 RETURNING INTO。

| 用例 | 验证要点 |
|------|---------|
| 重载版1_无成本 | 序列生成 ID + INSERT + OUT 参数返回 item_id |
| 重载版2_带成本 | NVL(p_cost,0) → null 时默认 0，RETURNING INTO → 返回值 |
| 成本为null时NVL为0 | COALESCE(NULL, 0) → std_cost = 0 |

### core_pkg_get_bom_components.yaml（P1 中等）

**测试目标**：验证 BULK COLLECT INTO 集合返回。

| 用例 | 验证要点 |
|------|---------|
| 正常返回组件列表 | BULK COLLECT → List\<BomCompObj\>，元素字段正确 |
| 空BOM返回空列表 | 无匹配行 → 空 List（不是 null） |

### core_pkg_explode_bom.yaml（P2 高难）

**测试目标**：验证 PIPELINED 函数的翻译。

| 用例 | 验证要点 |
|------|---------|
| 正常展开_ACTIVE状态BOM | PIPELINED → 普通 List 返回，status='ACTIVE' 过滤 |
| 仅展开ACTIVE_BOM | DRAFT 状态 BOM 的组件不应出现 |
| 不存在物料返回空 | 无匹配 → 空 List |

### core_pkg_list_bom.yaml（P2 高难）

**测试目标**：验证 CONNECT BY 层次查询的翻译。

| 用例 | 验证要点 |
|------|---------|
| 两层BOM层次查询 | LEVEL、SYS_CONNECT_BY_PATH、CONNECT_BY_ISLEAF 正确 |
| 不存在物料返回空 | 无匹配 → 空结果 |
| 叶节点标记正确 | 无子 BOM 的组件 → is_leaf = true |

### core_pkg_bom_cost.yaml（P2 高难）

**测试目标**：验证递归函数的翻译。

| 用例 | 验证要点 |
|------|---------|
| 叶节点返回std_cost | 无 BOM → 直接返回 std_cost |
| 父件卷算成本 | 递归遍历子件，qty/(1-scrap_rate) 计算正确 |
| 不存在物料返回0 | NO_DATA_FOUND → return 0 |

### core_pkg_bulk_receive.yaml（P2 高难）

**测试目标**：验证 FORALL SAVE EXCEPTIONS + MERGE INTO 的翻译。

| 用例 | 验证要点 |
|------|---------|
| 正常批量收货 | FORALL INSERT → batch executor，p_ok = 全部数量 |
| 部分失败收集异常 | SAVE EXCEPTIONS → BatchUpdateException 收集失败行 |
| MERGE回写物料成本 | MERGE INTO → insertOrUpdate，AVG(unit_cost) 正确 |

### core_pkg_issue_fifo.yaml（P2 高难）

**测试目标**：验证窗口函数 + WHERE CURRENT OF FIFO 发料。

| 用例 | 验证要点 |
|------|---------|
| 单批次扣减 | 需求量 < 第一批可用量，只扣第一批 |
| 跨批次FIFO扣减 | 需求量跨两批，先扣完第一批再扣第二批 |
| 全部扣完 | 需求量 = 全部可用量，三批都扣为 0 |
| FIFO顺序正确 | 按 receipt_date 升序扣减（最早的先扣） |

### core_pkg_archive_before.yaml（P2 高难）

**测试目标**：验证 EXECUTE IMMEDIATE 动态 SQL 的翻译。

| 用例 | 验证要点 |
|------|---------|
| 删除指定日期前的流水 | USING 绑定变量，SQL%ROWCOUNT → 返回删除行数 |
| 边界日期不含当天 | 严格小于（<），当天数据不删 |
| 无匹配数据返回0 | 无行匹配 → 返回 0 |

### trg_item_audit.yaml（P1 中等）

**测试目标**：验证行级触发器的翻译（AOP/MyBatis Interceptor）。

| 用例 | 验证要点 |
|------|---------|
| std_cost变化触发审计 | AFTER UPDATE OF std_cost → 写 t_error_log |
| status变化触发审计 | AFTER UPDATE OF status → 写 t_error_log |
| 其他列变化不触发 | 不在 UPDATE OF 列表中的列 → 不写审计 |
| 值未变化不触发 | WHEN (old <> new) 条件 → 值相同不触发 |

## 宽容比对规则

比对器在比较 Oracle/PostgreSQL 和 Java 结果时，应用以下宽容规则：

| 类型 | 规则 | 示例 |
|------|------|------|
| BigDecimal | 忽略 scale 差异 | `10.50` == `10.5` |
| NULL / 空串 | Oracle 空串 ≈ NULL | `""` == `null` |
| 浮点数 | 容忍 epsilon 误差 | 默认 tolerance = 0.0001 |
| Date/Time | 归一化到时区 | 忽略微秒差异 |
| List 顺序 | 按预期顺序比对 | 如指定 ORDER BY 则严格比对 |

## 跳过条件

以下情况用例标记为 `skipped`：

- 无 PostgreSQL 数据库连接
- setup.sql 执行失败（表不存在等）
- 依赖的 Java 类未编译通过

## 扩展指南

### 新增测试用例

1. 在本目录下创建 `<subprogram_name>.yaml`
2. 按上述 YAML 格式编写
3. 确保 `setup.sql` 使用 PostgreSQL 语法（orafce 兼容）
4. 重新运行 `/sql2java_evaluation --layers l4`

### 修改已有用例

直接编辑对应的 YAML 文件即可，无需修改其他配置。
