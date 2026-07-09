-- 采购: PO 状态机 / 收货过账 / MRP 转采购单 / 补货扫描 / 供应商排名
-- PO 状态机: DRAFT -> APPROVED -> PARTIAL -> RECEIVED -> CLOSED，行状态汇总驱动头状态
-- 收货过账委托 MFG_ERP.F_INVENTORY.receive_stock，同事务更新 PO 行 qty_received 与状态
-- 补货扫描用游标 + where current of；供应商排名用 rank/分析函数

CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE MFG_ERP.F_PROCUREMENT IS
    -- Author : sql2java-workflow
    -- Created : 2026-07-03
    -- Purpose : 采购: PO 状态机 / 收货过账 / MRP 转采购单 / 补货扫描 / 供应商排名 / PO 状态机: DRAFT -> APPROVED -> PARTIAL -> RECEIVED -> CLOSED，行状态汇总驱动头状态 / 收货过账委托 MFG_ERP.F_INVENTORY.receive_stock，同事务更新 PO 行 qty_received 与状态 / 补货扫描用游标 + where current of；供应商排名用 rank/分析函数

    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：create_po
    *****************************************************************/
    PROCEDURE create_po(
        ii_supplier_id  IN  NUMBER,
        ii_warehouse_id IN  NUMBER,
        id_expected_date IN DATE,
        oi_po_id        OUT NUMBER,
        os_po_no        OUT VARCHAR2
    );

    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：add_po_line
    *****************************************************************/
    PROCEDURE add_po_line(
        ii_po_id       IN NUMBER,
        ii_item_id     IN NUMBER,
        ii_qty         IN NUMBER,
        ii_unit_price  IN NUMBER,
        is_uom         IN VARCHAR2 DEFAULT NULL,
        id_need_date   IN DATE     DEFAULT NULL
    );

    -- 审核: DRAFT -> APPROVED，校验供应商未被冻结
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：审核: DRAFT -> APPROVED，校验供应商未被冻结
    *****************************************************************/
    PROCEDURE approve_po(ii_po_id IN NUMBER);

    -- 收货过账: 对某 PO 行收货，调库存收货 + 累加 qty_received + 重算行/头状态(状态机)
    -- 超收抛 e_po_over_receipt
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：收货过账: 对某 PO 行收货，调库存收货 + 累加 qty_received + 重算行/头状态(状态机) / 超收抛 e_po_over_receipt
    *****************************************************************/
    PROCEDURE receive_po_line(
        ii_po_id     IN NUMBER,
        ii_line_no   IN NUMBER,
        ii_qty       IN NUMBER,
        ii_unit_cost IN NUMBER DEFAULT NULL
    );

    -- 把一次 MRP 运行的计划下单建议批量转成采购单(按供应商归并)，bulk + 集合
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：把一次 MRP 运行的计划下单建议批量转成采购单(按供应商归并)，bulk + 集合
    *****************************************************************/
    PROCEDURE create_po_from_mrp(
        ii_run_id     IN  NUMBER,
        oi_po_count   OUT NUMBER
    );

    -- 补货扫描: 游标遍历低于再订货点的物料，where current of 标记并产生补货建议
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：补货扫描: 游标遍历低于再订货点的物料，where current of 标记并产生补货建议
    *****************************************************************/
    PROCEDURE reorder_scan(
        ii_warehouse_id IN  NUMBER,
        oi_suggest_count OUT NUMBER
    );

    -- 供应商排名: 按采购金额/到货及时率排名(rank/dense_rank/分析函数)
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：供应商排名: 按采购金额/到货及时率排名(rank/dense_rank/分析函数)
    *****************************************************************/
    PROCEDURE supplier_ranking(
        id_from_date IN  DATE,
        id_to_date   IN  DATE,
        or_cur       OUT SYS_REFCURSOR
    );

    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：cancel_po
    *****************************************************************/
    PROCEDURE cancel_po(ii_po_id IN NUMBER, is_reason IN VARCHAR2);

END f_procurement;
