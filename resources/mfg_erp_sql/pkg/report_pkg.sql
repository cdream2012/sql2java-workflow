-- 报表: 静态透视 / 行转列聚合 / 多维小计 / 库龄分桶 / 排名 / 帕累托
-- 集中演示分析与集合类 SQL: pivot、listagg、rollup/cube/grouping sets、窗口函数、grouping()

CREATE OR REPLACE PACKAGE report_pkg AS

    -- BOM 当层组件清单拼成一行字符串(listagg，按 line_no 排序)
    FUNCTION bom_component_list(p_bom_id IN NUMBER) RETURN VARCHAR2;

    -- 库存按仓库透视: 行=物料，列=各仓库在手量(静态 pivot)
    PROCEDURE inventory_by_warehouse(p_cur OUT SYS_REFCURSOR);

    -- 销售汇总(多维小计): 按 分类 x 客户 rollup/cube，grouping() 标小计行
    PROCEDURE sales_summary(
        p_from_date IN  DATE,
        p_to_date   IN  DATE,
        p_group_mode IN VARCHAR2 DEFAULT 'ROLLUP',
        p_cur       OUT SYS_REFCURSOR
    );

    -- 库龄分析: 按入库距今天数分桶，ntile 四分位，窗口算占比
    PROCEDURE stock_aging(p_cur OUT SYS_REFCURSOR);

    -- 物料消耗 Top N: row_number/rank/dense_rank + fetch first n rows
    PROCEDURE top_consumed_items(
        p_from_date IN  DATE,
        p_to_date   IN  DATE,
        p_top_n     IN  NUMBER DEFAULT 10,
        p_cur       OUT SYS_REFCURSOR
    );

    -- 库存货值帕累托: 按货值降序累计占比(sum over order by + ratio_to_report)，给 ABC 决策
    PROCEDURE inventory_pareto(p_cur OUT SYS_REFCURSOR);

END report_pkg;
/

-- report_pkg 包体: 只读分析报表，全部走 ref cursor / 标量返回，不改数据
-- 这里集中演示分析类 SQL，sql2java 侧多半映射成只读 Mapper + VO，列别名即字段名
-- 库存口径: 余额表 t_inventory_balance 是物料+仓库快照，批次表 t_inventory_lot 带 receipt_date 可算库龄
-- 消耗口径: 流水表 t_inventory_txn 的出库方向(ISSUE/PROD_OUT)累计，比从订单推更准

CREATE OR REPLACE PACKAGE BODY report_pkg AS

    FUNCTION bom_component_list(p_bom_id IN NUMBER) RETURN VARCHAR2 IS
        v_result VARCHAR2(4000);
        v_exists NUMBER;
    BEGIN
        SELECT COUNT(*) INTO v_exists
          FROM t_bom_header WHERE bom_id = p_bom_id;
        IF v_exists = 0 THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_bom_not_found, const_pkg.c_mod_report, 'bom_component_list',
                'BOM 头不存在 bom_id=' || p_bom_id, TO_CHAR(p_bom_id));
        END IF;

        -- listagg 把当层组件拼成一行: "10:RAW-001 钢板 x2.5KG; 20:..."
        -- 排序键放进 listagg 的 within group，保证拼出来按工艺行号
        SELECT LISTAGG(
                   l.line_no || ':' || i.item_code || ' ' || i.item_name
                       || ' x' || util_pkg.format_qty(l.qty_per, l.uom),
                   '; ') WITHIN GROUP (ORDER BY l.line_no)
          INTO v_result
          FROM t_bom_line l
          JOIN t_item     i ON i.item_id = l.component_item_id
         WHERE l.bom_id = p_bom_id;

        RETURN v_result;
    END bom_component_list;


    PROCEDURE inventory_by_warehouse(p_cur OUT SYS_REFCURSOR) IS
    BEGIN
        -- 静态 pivot: 仓库就那三个(WH-RAW/WH-FG/WH-WIP)，列写死
        -- 新增仓库要改这里，动态列数的场景见 forecast_pkg.pivot_demand_dynamic 走 DBMS_SQL
        OPEN p_cur FOR
            SELECT item_id,
                   item_code,
                   item_name,
                   NVL(wh_raw, 0) AS qty_wh_raw,
                   NVL(wh_fg,  0) AS qty_wh_fg,
                   NVL(wh_wip, 0) AS qty_wh_wip,
                   NVL(wh_raw, 0) + NVL(wh_fg, 0) + NVL(wh_wip, 0) AS qty_total
              FROM (
                    SELECT i.item_id,
                           i.item_code,
                           i.item_name,
                           b.warehouse_id,
                           b.qty_on_hand
                      FROM t_inventory_balance b
                      JOIN t_item i ON i.item_id = b.item_id
                     WHERE b.qty_on_hand > 0
                   )
              PIVOT (
                    SUM(qty_on_hand)
                    FOR warehouse_id IN (1 AS wh_raw, 2 AS wh_fg, 3 AS wh_wip)
              )
             ORDER BY item_code;
    END inventory_by_warehouse;


    PROCEDURE sales_summary(
        p_from_date  IN  DATE,
        p_to_date    IN  DATE,
        p_group_mode IN  VARCHAR2 DEFAULT 'ROLLUP',
        p_cur        OUT SYS_REFCURSOR
    ) IS
        v_mode VARCHAR2(8);
    BEGIN
        v_mode := UPPER(NVL(p_group_mode, 'ROLLUP'));
        IF v_mode NOT IN ('ROLLUP', 'CUBE') THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_system, const_pkg.c_mod_report, 'sales_summary',
                'p_group_mode 只支持 ROLLUP / CUBE，传入=' || p_group_mode);
        END IF;

        -- 口径取销售订单行 t_so_line join t_sales_order，按订单日期落区间
        -- 没有独立的发货事实表，已发量用 qty_shipped 体现，未发也计入(分析销售订单而非出库)
        -- 维度: 物料分类 x 客户。grouping_id 标识汇总层级:
        --   0 = 明细(分类+客户) / 1 = 按分类小计 / 2 = 按客户小计(仅 cube) / 3 = 总计
        -- rollup 与 cube 在编译期就要定，故拆两支 open，避免拼动态 SQL
        IF v_mode = 'CUBE' THEN
            OPEN p_cur FOR
                SELECT cat.category_id,
                       cat.category_name,
                       so.customer_id,
                       cu.customer_name,
                       GROUPING(cat.category_id)  AS g_category,
                       GROUPING(so.customer_id)   AS g_customer,
                       GROUPING_ID(cat.category_id, so.customer_id) AS gid,
                       COUNT(DISTINCT so.so_id)   AS order_count,
                       SUM(sl.qty_ordered)        AS qty_ordered,
                       SUM(sl.qty_shipped)        AS qty_shipped,
                       SUM(sl.qty_ordered * sl.unit_price * (1 - sl.discount_pct)) AS amount
                  FROM t_so_line      sl
                  JOIN t_sales_order  so  ON so.so_id      = sl.so_id
                  JOIN t_item         it  ON it.item_id    = sl.item_id
                  LEFT JOIN t_item_category cat ON cat.category_id = it.category_id
                  JOIN t_customer     cu  ON cu.customer_id = so.customer_id
                 WHERE so.order_date BETWEEN p_from_date AND p_to_date
                   AND so.status <> const_pkg.c_line_cancel
                 GROUP BY CUBE(cat.category_id, so.customer_id),
                          cat.category_name, cu.customer_name
                 ORDER BY GROUPING_ID(cat.category_id, so.customer_id),
                          cat.category_id, so.customer_id;
        ELSE
            OPEN p_cur FOR
                SELECT cat.category_id,
                       cat.category_name,
                       so.customer_id,
                       cu.customer_name,
                       GROUPING(cat.category_id)  AS g_category,
                       GROUPING(so.customer_id)   AS g_customer,
                       GROUPING_ID(cat.category_id, so.customer_id) AS gid,
                       COUNT(DISTINCT so.so_id)   AS order_count,
                       SUM(sl.qty_ordered)        AS qty_ordered,
                       SUM(sl.qty_shipped)        AS qty_shipped,
                       SUM(sl.qty_ordered * sl.unit_price * (1 - sl.discount_pct)) AS amount
                  FROM t_so_line      sl
                  JOIN t_sales_order  so  ON so.so_id      = sl.so_id
                  JOIN t_item         it  ON it.item_id    = sl.item_id
                  LEFT JOIN t_item_category cat ON cat.category_id = it.category_id
                  JOIN t_customer     cu  ON cu.customer_id = so.customer_id
                 WHERE so.order_date BETWEEN p_from_date AND p_to_date
                   AND so.status <> const_pkg.c_line_cancel
                 GROUP BY ROLLUP(cat.category_id, so.customer_id),
                          cat.category_name, cu.customer_name
                 ORDER BY GROUPING_ID(cat.category_id, so.customer_id),
                          cat.category_id, so.customer_id;
        END IF;
    END sales_summary;


    PROCEDURE stock_aging(p_cur OUT SYS_REFCURSOR) IS
    BEGIN
        -- 库龄按批次算: 余额表没有入库时间，只有 t_inventory_lot.receipt_date 能定库龄
        -- 分桶 0-30/31-60/61-90/90+，ntile(4) 给全体批次按库龄四分位
        -- 占比窗口: 各桶在手量 / 全部在手量，over() 空窗即全集
        OPEN p_cur FOR
            WITH lot_age AS (
                SELECT l.lot_id,
                       l.lot_no,
                       l.item_id,
                       i.item_code,
                       i.item_name,
                       l.warehouse_id,
                       l.qty_on_hand,
                       l.receipt_date,
                       TRUNC(SYSDATE) - TRUNC(l.receipt_date) AS age_days
                  FROM t_inventory_lot l
                  JOIN t_item i ON i.item_id = l.item_id
                 WHERE l.status = const_pkg.c_lot_available
                   AND l.qty_on_hand > 0
            )
            SELECT lot_id,
                   lot_no,
                   item_code,
                   item_name,
                   warehouse_id,
                   qty_on_hand,
                   receipt_date,
                   age_days,
                   CASE
                       WHEN age_days <= 30 THEN '0-30'
                       WHEN age_days <= 60 THEN '31-60'
                       WHEN age_days <= 90 THEN '61-90'
                       ELSE '90+'
                   END AS age_bucket,
                   NTILE(4) OVER (ORDER BY age_days) AS age_quartile,
                   ROUND(qty_on_hand
                         / SUM(qty_on_hand) OVER () * 100, 2) AS qty_pct
              FROM lot_age
             ORDER BY age_days DESC, item_code;
    END stock_aging;


    PROCEDURE top_consumed_items(
        p_from_date IN  DATE,
        p_to_date   IN  DATE,
        p_top_n     IN  NUMBER DEFAULT 10,
        p_cur       OUT SYS_REFCURSOR
    ) IS
    BEGIN
        -- 消耗只算出库方向且属领料/生产投料口径(ISSUE/PROD_OUT)，调拨与退货不算消耗
        -- 三种排名都给: row_number 唯一序、rank 同分跳号、dense_rank 同分连号
        -- fetch first n: 取前 N，并列时 row_number 仍只返回 N 行(要含并列改 with ties)
        OPEN p_cur FOR
            WITH consumption AS (
                SELECT t.item_id,
                       SUM(t.quantity)   AS consumed_qty,
                       SUM(t.total_cost) AS consumed_cost,
                       COUNT(*)          AS txn_count
                  FROM t_inventory_txn t
                 WHERE t.direction = const_pkg.c_dir_out
                   AND t.txn_type IN (const_pkg.c_txn_issue, const_pkg.c_txn_prod_out)
                   AND t.txn_date BETWEEN p_from_date AND p_to_date
                 GROUP BY t.item_id
            )
            SELECT i.item_code,
                   i.item_name,
                   i.item_type,
                   c.consumed_qty,
                   c.consumed_cost,
                   c.txn_count,
                   ROW_NUMBER() OVER (ORDER BY c.consumed_qty DESC) AS rn,
                   RANK()       OVER (ORDER BY c.consumed_qty DESC) AS rnk,
                   DENSE_RANK() OVER (ORDER BY c.consumed_qty DESC) AS dense_rnk
              FROM consumption c
              JOIN t_item i ON i.item_id = c.item_id
             ORDER BY c.consumed_qty DESC
             FETCH FIRST p_top_n ROWS ONLY;
    END top_consumed_items;


    PROCEDURE inventory_pareto(p_cur OUT SYS_REFCURSOR) IS
    BEGIN
        -- 帕累托/ABC: 按货值降序累计占比，给采购做库存重点管控的依据
        -- 货值口径: 余额在手量 * 移动加权平均成本(avg_cost)，FIFO 物料 avg_cost 仅参考但量级可用
        -- sum over(order by desc) 给累计货值，ratio_to_report over() 给单项占比
        -- ABC 阈值: 累计占比 <=80% A 类, <=95% B 类, 其余 C 类(经典 80/15/5)
        OPEN p_cur FOR
            WITH item_value AS (
                SELECT i.item_id,
                       i.item_code,
                       i.item_name,
                       i.abc_class AS abc_class_current,
                       SUM(b.qty_on_hand)                  AS qty_on_hand,
                       SUM(b.qty_on_hand * b.avg_cost)     AS stock_value
                  FROM t_inventory_balance b
                  JOIN t_item i ON i.item_id = b.item_id
                 GROUP BY i.item_id, i.item_code, i.item_name, i.abc_class
                HAVING SUM(b.qty_on_hand * b.avg_cost) > 0
            ),
            ranked AS (
                SELECT item_id,
                       item_code,
                       item_name,
                       abc_class_current,
                       qty_on_hand,
                       stock_value,
                       ROUND(RATIO_TO_REPORT(stock_value) OVER () * 100, 4) AS value_pct,
                       ROUND(SUM(stock_value) OVER (ORDER BY stock_value DESC)
                             / SUM(stock_value) OVER () * 100, 4)           AS cum_pct,
                       ROW_NUMBER() OVER (ORDER BY stock_value DESC)        AS value_rank
                  FROM item_value
            )
            SELECT item_id,
                   item_code,
                   item_name,
                   abc_class_current,
                   qty_on_hand,
                   stock_value,
                   value_pct,
                   cum_pct,
                   value_rank,
                   CASE
                       WHEN cum_pct <= 80 THEN 'A'
                       WHEN cum_pct <= 95 THEN 'B'
                       ELSE 'C'
                   END AS abc_class_calc
              FROM ranked
             ORDER BY stock_value DESC;
    END inventory_pareto;

END report_pkg;
/
