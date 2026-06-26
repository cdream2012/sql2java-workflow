-- 全局常量
-- 错误码分域: M1 物料/分类 / M2 BOM / M3 库存 / M4 采购订单 / M5 MRP生产 / M6 定价 / M9 系统
-- 错误码与 exc_pkg 的 pragma exception_init、raise_biz_error 里的 SQLCODE 映射三处必须同步

CREATE OR REPLACE PACKAGE const_pkg AS

    -- 错误码: 物料/分类
    c_err_item_not_found       CONSTANT VARCHAR2(16) := 'M1001';
    c_err_item_obsolete        CONSTANT VARCHAR2(16) := 'M1002';
    c_err_category_not_found   CONSTANT VARCHAR2(16) := 'M1003';
    c_err_category_cycle       CONSTANT VARCHAR2(16) := 'M1004';
    c_err_uom_not_found        CONSTANT VARCHAR2(16) := 'M1101';
    c_err_uom_incompatible     CONSTANT VARCHAR2(16) := 'M1102';

    -- 错误码: BOM
    c_err_bom_not_found        CONSTANT VARCHAR2(16) := 'M2001';
    c_err_bom_cycle            CONSTANT VARCHAR2(16) := 'M2002';
    c_err_bom_no_active        CONSTANT VARCHAR2(16) := 'M2003';
    c_err_bom_line_invalid     CONSTANT VARCHAR2(16) := 'M2004';

    -- 错误码: 库存
    c_err_stock_insufficient   CONSTANT VARCHAR2(16) := 'M3001';
    c_err_lot_not_found        CONSTANT VARCHAR2(16) := 'M3002';
    c_err_lot_expired          CONSTANT VARCHAR2(16) := 'M3003';
    c_err_balance_not_found    CONSTANT VARCHAR2(16) := 'M3004';
    c_err_stock_negative       CONSTANT VARCHAR2(16) := 'M3005';

    -- 错误码: 采购订单
    c_err_po_not_found         CONSTANT VARCHAR2(16) := 'M4001';
    c_err_po_status_invalid    CONSTANT VARCHAR2(16) := 'M4002';
    c_err_po_over_receipt      CONSTANT VARCHAR2(16) := 'M4003';
    c_err_supplier_blocked     CONSTANT VARCHAR2(16) := 'M4004';

    -- 错误码: MRP / 生产
    c_err_mrp_running          CONSTANT VARCHAR2(16) := 'M5001';
    c_err_mrp_run_not_found    CONSTANT VARCHAR2(16) := 'M5002';
    c_err_prod_not_found       CONSTANT VARCHAR2(16) := 'M5003';

    -- 错误码: 定价
    c_err_price_rule_missing   CONSTANT VARCHAR2(16) := 'M6001';
    c_err_price_list_not_found CONSTANT VARCHAR2(16) := 'M6002';

    c_err_system               CONSTANT VARCHAR2(16) := 'M9999';

    -- 物料类型
    c_item_raw   CONSTANT VARCHAR2(8) := 'RAW';
    c_item_semi  CONSTANT VARCHAR2(8) := 'SEMI';
    c_item_fg    CONSTANT VARCHAR2(8) := 'FG';
    c_item_svc   CONSTANT VARCHAR2(8) := 'SVC';

    -- 估值方法
    c_val_fifo   CONSTANT VARCHAR2(8) := 'FIFO';
    c_val_std    CONSTANT VARCHAR2(8) := 'STD';
    c_val_avg    CONSTANT VARCHAR2(8) := 'AVG';
    c_val_none   CONSTANT VARCHAR2(8) := 'NONE';

    -- 库存事务类型
    c_txn_recv      CONSTANT VARCHAR2(12) := 'RECV';
    c_txn_issue     CONSTANT VARCHAR2(12) := 'ISSUE';
    c_txn_adj       CONSTANT VARCHAR2(12) := 'ADJ';
    c_txn_xfer_out  CONSTANT VARCHAR2(12) := 'XFER_OUT';
    c_txn_xfer_in   CONSTANT VARCHAR2(12) := 'XFER_IN';
    c_txn_prod_in   CONSTANT VARCHAR2(12) := 'PROD_IN';
    c_txn_prod_out  CONSTANT VARCHAR2(12) := 'PROD_OUT';
    c_txn_return    CONSTANT VARCHAR2(12) := 'RETURN';

    -- 库存方向
    c_dir_in    CONSTANT CHAR(1) := 'I';
    c_dir_out   CONSTANT CHAR(1) := 'O';

    -- 批次状态
    c_lot_available  CONSTANT VARCHAR2(12) := 'AVAILABLE';
    c_lot_quarantine CONSTANT VARCHAR2(12) := 'QUARANTINE';
    c_lot_expired    CONSTANT VARCHAR2(12) := 'EXPIRED';
    c_lot_consumed   CONSTANT VARCHAR2(12) := 'CONSUMED';

    -- 采购订单状态
    c_po_draft     CONSTANT VARCHAR2(12) := 'DRAFT';
    c_po_approved  CONSTANT VARCHAR2(12) := 'APPROVED';
    c_po_partial   CONSTANT VARCHAR2(12) := 'PARTIAL';
    c_po_received  CONSTANT VARCHAR2(12) := 'RECEIVED';
    c_po_closed    CONSTANT VARCHAR2(12) := 'CLOSED';
    c_po_cancelled CONSTANT VARCHAR2(12) := 'CANCELLED';

    -- 订单行状态
    c_line_open    CONSTANT VARCHAR2(12) := 'OPEN';
    c_line_partial CONSTANT VARCHAR2(12) := 'PARTIAL';
    c_line_closed  CONSTANT VARCHAR2(12) := 'CLOSED';
    c_line_cancel  CONSTANT VARCHAR2(12) := 'CANCELLED';

    -- 生产工单状态
    c_prod_planned    CONSTANT VARCHAR2(12) := 'PLANNED';
    c_prod_released   CONSTANT VARCHAR2(12) := 'RELEASED';
    c_prod_inprogress CONSTANT VARCHAR2(12) := 'IN_PROGRESS';
    c_prod_completed  CONSTANT VARCHAR2(12) := 'COMPLETED';
    c_prod_closed     CONSTANT VARCHAR2(12) := 'CLOSED';

    -- MRP 运行状态
    c_mrp_running CONSTANT VARCHAR2(12) := 'RUNNING';
    c_mrp_success CONSTANT VARCHAR2(12) := 'SUCCESS';
    c_mrp_failed  CONSTANT VARCHAR2(12) := 'FAILED';
    c_mrp_partial CONSTANT VARCHAR2(12) := 'PARTIAL';

    -- 定价规则类型
    c_rule_list         CONSTANT VARCHAR2(16) := 'LIST';
    c_rule_discount_pct CONSTANT VARCHAR2(16) := 'DISCOUNT_PCT';
    c_rule_discount_amt CONSTANT VARCHAR2(16) := 'DISCOUNT_AMT';
    c_rule_override     CONSTANT VARCHAR2(16) := 'OVERRIDE';

    -- 业务参数(高频读，做成包常量；可配的放 t_app_param)
    c_default_currency   CONSTANT VARCHAR2(8) := 'CNY';
    c_max_bom_levels     CONSTANT NUMBER := 20;
    c_year_days          CONSTANT NUMBER := 365;
    c_bulk_limit         CONSTANT NUMBER := 1000;

    -- 模块名(错误日志/审计)
    c_mod_item     CONSTANT VARCHAR2(64) := 'ITEM';
    c_mod_bom      CONSTANT VARCHAR2(64) := 'BOM';
    c_mod_inv      CONSTANT VARCHAR2(64) := 'INVENTORY';
    c_mod_cost     CONSTANT VARCHAR2(64) := 'COSTING';
    c_mod_price    CONSTANT VARCHAR2(64) := 'PRICING';
    c_mod_procure  CONSTANT VARCHAR2(64) := 'PROCUREMENT';
    c_mod_mrp      CONSTANT VARCHAR2(64) := 'MRP';
    c_mod_forecast CONSTANT VARCHAR2(64) := 'FORECAST';
    c_mod_report   CONSTANT VARCHAR2(64) := 'REPORT';
    c_mod_util     CONSTANT VARCHAR2(64) := 'UTIL';
    c_mod_sched    CONSTANT VARCHAR2(64) := 'SCHED';

END const_pkg;
/
