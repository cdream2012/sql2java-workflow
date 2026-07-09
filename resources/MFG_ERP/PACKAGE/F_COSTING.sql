-- 成本: FIFO 分层 / 库存估值 / 移动加权平均 / 落地成本 / 标准成本卷算
-- 分析函数是本包主题: 累计求和、ratio_to_report、ntile 都用上
-- 落地成本报表用 with function(SQL 内联 PL/SQL 函数)，把分摊算法写在查询里

CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE MFG_ERP.F_COSTING IS
    -- Author : sql2java-workflow
    -- Created : 2026-07-03
    -- Purpose : 成本: FIFO 分层 / 库存估值 / 移动加权平均 / 落地成本 / 标准成本卷算 / 分析函数是本包主题: 累计求和、ratio_to_report、ntile 都用上 / 落地成本报表用 with function(SQL 内联 PL/SQL 函数)，把分摊算法写在查询里

    -- FIFO 成本分层: 窗口函数算每批的累计可用量与累计金额，定位"第几批起覆盖需求"
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：FIFO 成本分层: 窗口函数算每批的累计可用量与累计金额，定位"第几批起覆盖需求"
    *****************************************************************/
    PROCEDURE fifo_layers(
        ii_item_id      IN  NUMBER,
        ii_warehouse_id IN  NUMBER,
        or_cur          OUT SYS_REFCURSOR
    );

    -- 库存估值表: 按仓库逐物料算货值，SUM() OVER() 给出仓库小计与占比
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：库存估值表: 按仓库逐物料算货值，SUM() OVER() 给出仓库小计与占比
    *****************************************************************/
    PROCEDURE inventory_value(
        ii_warehouse_id IN  NUMBER   DEFAULT NULL,
        or_cur          OUT SYS_REFCURSOR
    );

    -- 重算移动加权平均成本并回写 t_inventory_balance.avg_cost
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：重算移动加权平均成本并回写 t_inventory_balance.avg_cost
    *****************************************************************/
    PROCEDURE recompute_avg_cost(ii_item_id IN NUMBER, ii_warehouse_id IN NUMBER);

    -- 落地成本报表: WITH FUNCTION 内联 PL/SQL 把运费/关税按金额或重量分摊到行
    -- 演示 SQL 里直接定义并调用 PL/SQL 函数(WITH FUNCTION 子句)
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：落地成本报表: WITH FUNCTION 内联 PL/SQL 把运费/关税按金额或重量分摊到行 / 演示 SQL 里直接定义并调用 PL/SQL 函数(WITH FUNCTION 子句)
    *****************************************************************/
    PROCEDURE landed_cost_report(
        ii_po_id  IN  NUMBER,
        or_cur    OUT SYS_REFCURSOR
    );

    -- 标准成本卷算回写: 对所有成品/半成品算 rolled cost 后 MERGE 回 t_item.std_cost
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：标准成本卷算回写: 对所有成品/半成品算 rolled cost 后 MERGE 回 t_item.std_cost
    *****************************************************************/
    PROCEDURE roll_standard_cost(id_as_of IN DATE DEFAULT NULL);

END f_costing;

-- 成本计算实现
-- 本包以分析函数为主线: FIFO 分层与估值占比靠窗口函数,落地成本分摊靠 SQL 内联 PL/SQL(with function)
-- 标准成本卷算把 BOM 递归交给 MFG_ERP.F_BOM.rolled_cost,本包只负责挑成品/半成品并 merge 回写
-- 多数子程序 open ref cursor 返回,让应用层流式取,不在库内物化大结果集
