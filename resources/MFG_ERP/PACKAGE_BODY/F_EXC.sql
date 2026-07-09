CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE BODY MFG_ERP.F_EXC AS

    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：log_error
    *****************************************************************/
    PROCEDURE log_error(
        is_error_code   IN VARCHAR2,
        is_module       IN VARCHAR2,
        is_procedure    IN VARCHAR2,
        is_error_msg    IN VARCHAR2,
        is_biz_key      IN VARCHAR2 DEFAULT NULL,
        is_context      IN CLOB     DEFAULT NULL,
        is_error_level  IN VARCHAR2 DEFAULT 'ERROR'
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
            seq_error_log_id.NEXTVAL, is_error_code, is_error_level,
            is_module, is_procedure,
            SUBSTR(is_error_msg, 1, 2000), format_error_stack(),
            is_biz_key, is_context,
            NVL(SYS_CONTEXT('userenv','session_user'), 'SYSTEM'), CURRENT_TIMESTAMP
        );
        COMMIT;

        IF g_debug_on THEN
            DBMS_OUTPUT.PUT_LINE('[' || is_error_level || '] ' || is_module
                || '.' || is_procedure || ' ' || is_error_code || ': ' || is_error_msg);
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            ROLLBACK;
            DBMS_OUTPUT.PUT_LINE('[FATAL] MFG_ERP.F_EXC.log_error self-failed: ' || SQLERRM);
    END log_error;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：raise_biz_error
    *****************************************************************/
    PROCEDURE raise_biz_error(
        is_error_code  IN VARCHAR2,
        is_module      IN VARCHAR2,
        is_procedure   IN VARCHAR2,
        is_error_msg   IN VARCHAR2,
        is_biz_key     IN VARCHAR2 DEFAULT NULL
    ) IS
        v_sqlcode NUMBER;
    BEGIN
        log_error(
            is_error_code  => is_error_code,
            is_module      => is_module,
            is_procedure   => is_procedure,
            is_error_msg   => is_error_msg,
            is_biz_key     => is_biz_key,
            is_error_level => 'ERROR'
        );

        -- 错误码到 SQLCODE 的映射，与 spec 的 pragma exception_init 严格对应
        v_sqlcode := CASE is_error_code
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

        RAISE_APPLICATION_ERROR(v_sqlcode, is_error_code || ': ' || is_error_msg);
    END raise_biz_error;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：debug
    *****************************************************************/
    PROCEDURE debug(is_module IN VARCHAR2, is_msg IN VARCHAR2) IS
    BEGIN
        IF g_debug_on THEN
            DBMS_OUTPUT.PUT_LINE('[DEBUG] ' || TO_CHAR(SYSTIMESTAMP, 'HH24:MI:SS.FF3')
                || ' ' || is_module || ' ' || is_msg);
        END IF;
    END debug;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：format_error_stack
    *****************************************************************/
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

END f_exc;
