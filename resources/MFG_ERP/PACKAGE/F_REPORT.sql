-- 报表: 静态透视 / 行转列聚合 / 多维小计 / 库龄分桶 / 排名 / 帕累托
-- 集中演示分析与集合类 SQL: pivot、listagg、rollup/cube/grouping sets、窗口函数、grouping()

CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE MFG_ERP.F_REPORT IS
    -- Author : sql2java-workflow
    -- Created : 2026-07-03
    -- Purpose : 报表: 静态透视 / 行转列聚合 / 多维小计 / 库龄分桶 / 排名 / 帕累托 / 集中演示分析与集合类 SQL: pivot、listagg、rollup/cube/grouping sets、窗口函数、grouping()

    -- BOM 当层组件清单拼成一行字符串(listagg，按 line_no 排序)
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：BOM 当层组件清单拼成一行字符串(listagg，按 line_no 排序)
    *****************************************************************/
    FUNCTION bom_component_list(ii_bom_id IN NUMBER) RETURN VARCHAR2;

    -- 库存按仓库透视: 行=物料，列=各仓库在手量(静态 pivot)
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：库存按仓库透视: 行=物料，列=各仓库在手量(静态 pivot)
    *****************************************************************/
    PROCEDURE inventory_by_warehouse(or_cur OUT SYS_REFCURSOR);

    -- 销售汇总(多维小计): 按 分类 x 客户 rollup/cube，grouping() 标小计行
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：销售汇总(多维小计): 按 分类 x 客户 rollup/cube，grouping() 标小计行
    *****************************************************************/
    PROCEDURE sales_summary(
        id_from_date IN  DATE,
        id_to_date   IN  DATE,
        is_group_mode IN VARCHAR2 DEFAULT 'ROLLUP',
        or_cur       OUT SYS_REFCURSOR
    );

    -- 库龄分析: 按入库距今天数分桶，ntile 四分位，窗口算占比
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：库龄分析: 按入库距今天数分桶，ntile 四分位，窗口算占比
    *****************************************************************/
    PROCEDURE stock_aging(or_cur OUT SYS_REFCURSOR);

    -- 物料消耗 Top N: row_number/rank/dense_rank + fetch first n rows
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：物料消耗 Top N: row_number/rank/dense_rank + fetch first n rows
    *****************************************************************/
    PROCEDURE top_consumed_items(
        id_from_date IN  DATE,
        id_to_date   IN  DATE,
        ii_top_n     IN  NUMBER DEFAULT 10,
        or_cur       OUT SYS_REFCURSOR
    );

    -- 库存货值帕累托: 按货值降序累计占比(sum over order by + ratio_to_report)，给 ABC 决策
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：库存货值帕累托: 按货值降序累计占比(sum over order by + ratio_to_report)，给 ABC 决策
    *****************************************************************/
    PROCEDURE inventory_pareto(or_cur OUT SYS_REFCURSOR);

END f_report;

-- F_REPORT 包体: 只读分析报表，全部走 ref cursor / 标量返回，不改数据
-- 这里集中演示分析类 SQL，sql2java 侧多半映射成只读 Mapper + VO，列别名即字段名
-- 库存口径: 余额表 t_inventory_balance 是物料+仓库快照，批次表 t_inventory_lot 带 receipt_date 可算库龄
-- 消耗口径: 流水表 t_inventory_txn 的出库方向(ISSUE/PROD_OUT)累计，比从订单推更准
