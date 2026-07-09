CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE BODY MFG_ERP.F_UTIL AS

    -- 单位小数位缓存，按 uom_code 索引，首次用到时懒加载
    TYPE t_uom_digits IS TABLE OF NUMBER INDEX BY VARCHAR2(8);
    g_uom_digits t_uom_digits;

    -- 单位所属 category 缓存，convert_qty 用来判同类
    TYPE t_uom_cat IS TABLE OF VARCHAR2(8) INDEX BY VARCHAR2(8);
    g_uom_cat t_uom_cat;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：load_uom_cache
    *****************************************************************/
    PROCEDURE load_uom_cache IS
    BEGIN
        g_uom_digits.DELETE;
        g_uom_cat.DELETE;
        FOR r IN (SELECT uom_code, uom_category, decimal_digits FROM t_uom) LOOP
            g_uom_digits(r.uom_code) := r.decimal_digits;
            g_uom_cat(r.uom_code)    := r.uom_category;
        END LOOP;
    END load_uom_cache;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：refresh_biz_date
    *****************************************************************/
    PROCEDURE refresh_biz_date IS
    BEGIN
        SELECT curr_biz_date, last_biz_date, next_biz_date
          INTO g_curr_biz_date, g_last_biz_date, g_next_biz_date
          FROM t_business_date
         WHERE sys_code = 'CORE';
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_system, MFG_ERP.F_CONST.c_mod_util, 'refresh_biz_date',
                '业务日期表 t_business_date(sys_code=CORE) 未初始化');
    END refresh_biz_date;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：curr_biz_date
    *****************************************************************/
    FUNCTION curr_biz_date RETURN DATE IS
    BEGIN
        IF g_curr_biz_date IS NULL THEN
            refresh_biz_date;
        END IF;
        RETURN g_curr_biz_date;
    END curr_biz_date;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：last_biz_date
    *****************************************************************/
    FUNCTION last_biz_date RETURN DATE IS
    BEGIN
        IF g_last_biz_date IS NULL THEN
            refresh_biz_date;
        END IF;
        RETURN g_last_biz_date;
    END last_biz_date;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：next_biz_date
    *****************************************************************/
    FUNCTION next_biz_date RETURN DATE IS
    BEGIN
        IF g_next_biz_date IS NULL THEN
            refresh_biz_date;
        END IF;
        RETURN g_next_biz_date;
    END next_biz_date;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：set_operator
    *****************************************************************/
    PROCEDURE set_operator(is_operator IN VARCHAR2) IS
    BEGIN
        g_curr_operator := NVL(is_operator, 'SYSTEM');
    END set_operator;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：get_operator
    *****************************************************************/
    FUNCTION get_operator RETURN VARCHAR2 IS
    BEGIN
        RETURN NVL(g_curr_operator, NVL(SYS_CONTEXT('userenv','session_user'), 'SYSTEM'));
    END get_operator;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：get_param
    *****************************************************************/
    FUNCTION get_param(is_key IN VARCHAR2, is_default IN VARCHAR2) RETURN VARCHAR2 IS
        v_val t_app_param.param_value%TYPE;
    BEGIN
        SELECT param_value INTO v_val FROM t_app_param WHERE param_key = is_key;
        RETURN NVL(v_val, is_default);
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            RETURN is_default;
    END get_param;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：get_param
    *****************************************************************/
    FUNCTION get_param(is_key IN VARCHAR2, ii_default IN NUMBER) RETURN NUMBER IS
        v_val t_app_param.param_value%TYPE;
    BEGIN
        SELECT param_value INTO v_val FROM t_app_param WHERE param_key = is_key;
        RETURN NVL(TO_NUMBER(v_val), ii_default);
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            RETURN ii_default;
        WHEN VALUE_ERROR THEN
            -- 配错成非数字时退回默认值并告警，不让跑批因一个脏参数崩掉
            MFG_ERP.F_EXC.log_error(
                MFG_ERP.F_CONST.c_err_system, MFG_ERP.F_CONST.c_mod_util, 'get_param',
                '参数非数字 key=' || is_key || ' val=' || v_val, is_key, NULL, 'WARN');
            RETURN ii_default;
    END get_param;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：get_param
    *****************************************************************/
    FUNCTION get_param(is_key IN VARCHAR2, id_default IN DATE) RETURN DATE IS
        v_val t_app_param.param_value%TYPE;
    BEGIN
        SELECT param_value INTO v_val FROM t_app_param WHERE param_key = is_key;
        RETURN NVL(TO_DATE(v_val, 'YYYY-MM-DD'), id_default);
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            RETURN id_default;
    END get_param;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：gen_doc_no
    *****************************************************************/
    FUNCTION gen_doc_no(is_prefix IN VARCHAR2, ii_seq IN NUMBER, id_date IN DATE DEFAULT NULL) RETURN VARCHAR2 IS
    BEGIN
        RETURN is_prefix || TO_CHAR(NVL(id_date, curr_biz_date), 'YYYYMMDD')
            || LPAD(MOD(ii_seq, 1000000), 6, '0');
    END gen_doc_no;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：convert_qty
    *****************************************************************/
    FUNCTION convert_qty(ii_qty IN NUMBER, is_from_uom IN VARCHAR2, is_to_uom IN VARCHAR2) RETURN NUMBER IS
        v_factor NUMBER;
    BEGIN
        IF is_from_uom = is_to_uom OR ii_qty IS NULL THEN
            RETURN ii_qty;
        END IF;

        IF g_uom_cat.COUNT = 0 THEN
            load_uom_cache;
        END IF;

        -- 跨类换算无意义(重量换不成长度)，直接拦
        IF NOT (g_uom_cat.EXISTS(is_from_uom) AND g_uom_cat.EXISTS(is_to_uom)) THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_uom_not_found, MFG_ERP.F_CONST.c_mod_util, 'convert_qty',
                '单位未定义 from=' || is_from_uom || ' to=' || is_to_uom, is_from_uom);
        END IF;
        IF g_uom_cat(is_from_uom) <> g_uom_cat(is_to_uom) THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_uom_incompatible, MFG_ERP.F_CONST.c_mod_util, 'convert_qty',
                '单位不同类不可换算 ' || is_from_uom || '(' || g_uom_cat(is_from_uom) || ') -> '
                || is_to_uom || '(' || g_uom_cat(is_to_uom) || ')', is_from_uom);
        END IF;

        $IF MFG_ERP.F_UTIL.c_trace_compile $THEN
            DBMS_OUTPUT.PUT_LINE('[TRACE] convert_qty ' || ii_qty || ' ' || is_from_uom || '->' || is_to_uom);
        $END

        BEGIN
            SELECT factor INTO v_factor
              FROM t_uom_conversion
             WHERE from_uom = is_from_uom AND to_uom = is_to_uom;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                -- 同类但缺直接换算系数，回退按基本单位枢轴折算
                SELECT f.factor / t.factor
                  INTO v_factor
                  FROM t_uom_conversion f
                  JOIN t_uom_conversion t ON t.from_uom = is_to_uom AND t.to_uom = f.to_uom
                 WHERE f.from_uom = is_from_uom
                   AND ROWNUM = 1;
        END;

        RETURN round_qty(ii_qty * v_factor, is_to_uom);
    END convert_qty;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：round_qty
    *****************************************************************/
    FUNCTION round_qty(ii_qty IN NUMBER, is_uom IN VARCHAR2) RETURN NUMBER IS
        v_digits NUMBER;
    BEGIN
        IF ii_qty IS NULL THEN
            RETURN NULL;
        END IF;
        IF g_uom_digits.COUNT = 0 THEN
            load_uom_cache;
        END IF;
        v_digits := CASE WHEN g_uom_digits.EXISTS(is_uom) THEN g_uom_digits(is_uom) ELSE 4 END;
        RETURN ROUND(ii_qty, v_digits);
    END round_qty;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：format_qty
    *****************************************************************/
    FUNCTION format_qty(ii_qty IN NUMBER, is_uom IN VARCHAR2 DEFAULT NULL) RETURN VARCHAR2 IS
        v_digits NUMBER;
        v_fmt    VARCHAR2(40);
    BEGIN
        IF ii_qty IS NULL THEN
            RETURN NULL;
        END IF;
        IF g_uom_digits.COUNT = 0 THEN
            load_uom_cache;
        END IF;
        v_digits := CASE WHEN is_uom IS NOT NULL AND g_uom_digits.EXISTS(is_uom)
                         THEN g_uom_digits(is_uom) ELSE 2 END;
        v_fmt := 'FM999,999,999,990'
              || CASE WHEN v_digits > 0 THEN '.' || RPAD('0', v_digits, '0') END;
        RETURN TRIM(TO_CHAR(ROUND(ii_qty, v_digits), v_fmt))
            || CASE WHEN is_uom IS NOT NULL THEN ' ' || is_uom END;
    END format_qty;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：clear_cache
    *****************************************************************/
    PROCEDURE clear_cache IS
    BEGIN
        g_curr_biz_date := NULL;
        g_last_biz_date := NULL;
        g_next_biz_date := NULL;
        g_uom_digits.DELETE;
        g_uom_cat.DELETE;
    END clear_cache;


-- 包初始化块: session 首次引用本包时跑一次，失败不炸 session
BEGIN
    g_session_id    := SYS_CONTEXT('userenv','sessionid');
    g_curr_operator := NVL(SYS_CONTEXT('userenv','session_user'), 'SYSTEM');
    BEGIN
        refresh_biz_date;
        load_uom_cache;
    EXCEPTION
        WHEN OTHERS THEN
            DBMS_OUTPUT.PUT_LINE('[WARN] F_UTIL init partially failed: ' || SQLERRM);
    END;
END f_util;
