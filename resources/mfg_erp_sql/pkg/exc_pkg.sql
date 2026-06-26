-- 业务异常 + 错误日志
-- 与 bank_core_sql 同构: 子模块抛错统一走 raise_biz_error，不直接 raise_application_error
-- 日志写入用自治事务，主事务回滚后日志仍在
-- 异常 -> SQLCODE 区间: -20101.. 与 const_pkg 错误码一一对应

CREATE OR REPLACE PACKAGE exc_pkg AS

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
    PROCEDURE log_error(
        p_error_code   IN VARCHAR2,
        p_module       IN VARCHAR2,
        p_procedure    IN VARCHAR2,
        p_error_msg    IN VARCHAR2,
        p_biz_key      IN VARCHAR2 DEFAULT NULL,
        p_context      IN CLOB     DEFAULT NULL,
        p_error_level  IN VARCHAR2 DEFAULT 'ERROR'
    );

    -- 抛业务异常并落日志，统一入口
    PROCEDURE raise_biz_error(
        p_error_code  IN VARCHAR2,
        p_module      IN VARCHAR2,
        p_procedure   IN VARCHAR2,
        p_error_msg   IN VARCHAR2,
        p_biz_key     IN VARCHAR2 DEFAULT NULL
    );

    PROCEDURE debug(p_module IN VARCHAR2, p_msg IN VARCHAR2);

    FUNCTION format_error_stack RETURN VARCHAR2;

    g_debug_on BOOLEAN := FALSE;

END exc_pkg;
/

CREATE OR REPLACE PACKAGE BODY exc_pkg AS

    PROCEDURE log_error(
        p_error_code   IN VARCHAR2,
        p_module       IN VARCHAR2,
        p_procedure    IN VARCHAR2,
        p_error_msg    IN VARCHAR2,
        p_biz_key      IN VARCHAR2 DEFAULT NULL,
        p_context      IN CLOB     DEFAULT NULL,
        p_error_level  IN VARCHAR2 DEFAULT 'ERROR'
    ) IS
        -- 自治事务: 日志独立提交，主流程 rollback 不带走日志
        PRAGMA AUTONOMOUS_TRANSACTION;
    BEGIN
        INSERT INTO t_error_log (
            log_id, error_code, error_level,
            module_name, procedure_name,
            error_msg, error_stack,
            biz_key, context_data,
            operator, occurred_at
        ) VALUES (
            seq_error_log_id.NEXTVAL, p_error_code, p_error_level,
            p_module, p_procedure,
            SUBSTR(p_error_msg, 1, 2000), format_error_stack(),
            p_biz_key, p_context,
            NVL(SYS_CONTEXT('userenv','session_user'), 'SYSTEM'), CURRENT_TIMESTAMP
        );
        COMMIT;

        IF g_debug_on THEN
            DBMS_OUTPUT.PUT_LINE('[' || p_error_level || '] ' || p_module
                || '.' || p_procedure || ' ' || p_error_code || ': ' || p_error_msg);
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            ROLLBACK;
            DBMS_OUTPUT.PUT_LINE('[FATAL] exc_pkg.log_error self-failed: ' || SQLERRM);
    END log_error;


    PROCEDURE raise_biz_error(
        p_error_code  IN VARCHAR2,
        p_module      IN VARCHAR2,
        p_procedure   IN VARCHAR2,
        p_error_msg   IN VARCHAR2,
        p_biz_key     IN VARCHAR2 DEFAULT NULL
    ) IS
        v_sqlcode NUMBER;
    BEGIN
        log_error(
            p_error_code  => p_error_code,
            p_module      => p_module,
            p_procedure   => p_procedure,
            p_error_msg   => p_error_msg,
            p_biz_key     => p_biz_key,
            p_error_level => 'ERROR'
        );

        -- 错误码到 SQLCODE 的映射，与 spec 的 pragma exception_init 严格对应
        v_sqlcode := CASE p_error_code
            WHEN 'M1001' THEN -20101
            WHEN 'M1002' THEN -20102
            WHEN 'M1003' THEN -20103
            WHEN 'M1004' THEN -20104
            WHEN 'M1101' THEN -20111
            WHEN 'M1102' THEN -20112
            WHEN 'M2001' THEN -20201
            WHEN 'M2002' THEN -20202
            WHEN 'M2003' THEN -20203
            WHEN 'M2004' THEN -20204
            WHEN 'M3001' THEN -20301
            WHEN 'M3002' THEN -20302
            WHEN 'M3003' THEN -20303
            WHEN 'M3004' THEN -20304
            WHEN 'M3005' THEN -20305
            WHEN 'M4001' THEN -20401
            WHEN 'M4002' THEN -20402
            WHEN 'M4003' THEN -20403
            WHEN 'M4004' THEN -20404
            WHEN 'M5001' THEN -20501
            WHEN 'M5002' THEN -20502
            WHEN 'M5003' THEN -20503
            WHEN 'M6001' THEN -20601
            WHEN 'M6002' THEN -20602
            ELSE -20999
        END;

        RAISE_APPLICATION_ERROR(v_sqlcode, p_error_code || ': ' || p_error_msg);
    END raise_biz_error;


    PROCEDURE debug(p_module IN VARCHAR2, p_msg IN VARCHAR2) IS
    BEGIN
        IF g_debug_on THEN
            DBMS_OUTPUT.PUT_LINE('[DEBUG] ' || TO_CHAR(SYSTIMESTAMP, 'HH24:MI:SS.FF3')
                || ' ' || p_module || ' ' || p_msg);
        END IF;
    END debug;


    FUNCTION format_error_stack RETURN VARCHAR2 IS
    BEGIN
        RETURN 'SQLCODE=' || SQLCODE || CHR(10)
            || 'SQLERRM=' || SQLERRM || CHR(10)
            || 'BACKTRACE=' || DBMS_UTILITY.FORMAT_ERROR_BACKTRACE || CHR(10)
            || 'CALL_STACK=' || DBMS_UTILITY.FORMAT_CALL_STACK;
    EXCEPTION
        WHEN OTHERS THEN
            RETURN 'SQLCODE=' || SQLCODE || ', SQLERRM=' || SQLERRM;
    END format_error_stack;

END exc_pkg;
/
