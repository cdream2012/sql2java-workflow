-- 业务异常 + 错误日志
-- 与 bank_core_sql 同构: 子模块抛错统一走 raise_biz_error，不直接 raise_application_error
-- 日志写入用自治事务，主事务回滚后日志仍在
-- 异常 -> SQLCODE 区间: -20101.. 与 F_CONST 错误码一一对应

CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE MFG_ERP.F_EXC IS
    -- Author : sql2java-workflow
    -- Created : 2026-07-03
    -- Purpose : 业务异常 + 错误日志 / 与 bank_core_sql 同构: 子模块抛错统一走 raise_biz_error，不直接 raise_application_error / 日志写入用自治事务，主事务回滚后日志仍在 / 异常 -> SQLCODE 区间: -20101.. 与 F_CONST 错误码一一对应

    e_item_not_found       EXCEPTION;
    e_item_obsolete        EXCEPTION;
    e_category_not_found   EXCEPTION;
    e_category_cycle       EXCEPTION;
    e_uom_not_found        EXCEPTION;
    e_uom_incompatible     EXCEPTION;
    e_bom_not_found        EXCEPTION;
    e_bom_cycle            EXCEPTION;
    e_bom_no_active        EXCEPTION;
    e_bom_line_invalid     EXCEPTION;
    e_stock_insufficient   EXCEPTION;
    e_lot_not_found        EXCEPTION;
    e_lot_expired          EXCEPTION;
    e_balance_not_found    EXCEPTION;
    e_stock_negative       EXCEPTION;
    e_po_not_found         EXCEPTION;
    e_po_status_invalid    EXCEPTION;
    e_po_over_receipt      EXCEPTION;
    e_supplier_blocked     EXCEPTION;
    e_mrp_running          EXCEPTION;
    e_mrp_run_not_found    EXCEPTION;
    e_prod_not_found       EXCEPTION;
    e_price_rule_missing   EXCEPTION;
    e_price_list_not_found EXCEPTION;

    PRAGMA EXCEPTION_INIT(e_item_not_found,       -20101);
    PRAGMA EXCEPTION_INIT(e_item_obsolete,        -20102);
    PRAGMA EXCEPTION_INIT(e_category_not_found,   -20103);
    PRAGMA EXCEPTION_INIT(e_category_cycle,       -20104);
    PRAGMA EXCEPTION_INIT(e_uom_not_found,        -20111);
    PRAGMA EXCEPTION_INIT(e_uom_incompatible,     -20112);
    PRAGMA EXCEPTION_INIT(e_bom_not_found,        -20201);
    PRAGMA EXCEPTION_INIT(e_bom_cycle,            -20202);
    PRAGMA EXCEPTION_INIT(e_bom_no_active,        -20203);
    PRAGMA EXCEPTION_INIT(e_bom_line_invalid,     -20204);
    PRAGMA EXCEPTION_INIT(e_stock_insufficient,   -20301);
    PRAGMA EXCEPTION_INIT(e_lot_not_found,        -20302);
    PRAGMA EXCEPTION_INIT(e_lot_expired,          -20303);
    PRAGMA EXCEPTION_INIT(e_balance_not_found,    -20304);
    PRAGMA EXCEPTION_INIT(e_stock_negative,       -20305);
    PRAGMA EXCEPTION_INIT(e_po_not_found,         -20401);
    PRAGMA EXCEPTION_INIT(e_po_status_invalid,    -20402);
    PRAGMA EXCEPTION_INIT(e_po_over_receipt,      -20403);
    PRAGMA EXCEPTION_INIT(e_supplier_blocked,     -20404);
    PRAGMA EXCEPTION_INIT(e_mrp_running,          -20501);
    PRAGMA EXCEPTION_INIT(e_mrp_run_not_found,    -20502);
    PRAGMA EXCEPTION_INIT(e_prod_not_found,       -20503);
    PRAGMA EXCEPTION_INIT(e_price_rule_missing,   -20601);
    PRAGMA EXCEPTION_INIT(e_price_list_not_found, -20602);

    -- 写错误日志(自治事务)
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：写错误日志(自治事务)
    *****************************************************************/
    PROCEDURE log_error(
        is_error_code   IN VARCHAR2,
        is_module       IN VARCHAR2,
        is_procedure    IN VARCHAR2,
        is_error_msg    IN VARCHAR2,
        is_biz_key      IN VARCHAR2 DEFAULT NULL,
        is_context      IN CLOB     DEFAULT NULL,
        is_error_level  IN VARCHAR2 DEFAULT 'ERROR'
    );

    -- 抛业务异常并落日志，统一入口
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：抛业务异常并落日志，统一入口
    *****************************************************************/
    PROCEDURE raise_biz_error(
        is_error_code  IN VARCHAR2,
        is_module      IN VARCHAR2,
        is_procedure   IN VARCHAR2,
        is_error_msg   IN VARCHAR2,
        is_biz_key     IN VARCHAR2 DEFAULT NULL
    );

    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：debug
    *****************************************************************/
    PROCEDURE debug(is_module IN VARCHAR2, is_msg IN VARCHAR2);

    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：format_error_stack
    *****************************************************************/
    FUNCTION format_error_stack RETURN VARCHAR2;

    g_debug_on BOOLEAN := FALSE;

END f_exc;
