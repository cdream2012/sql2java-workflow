-- 通用工具: 业务日期、参数读取(重载)、单据号、单位换算、脱敏格式化
-- 包级全局变量缓存业务日期，包初始化块首次引用时加载
-- get_param 用参数默认值的类型做重载: 同名三个，分别返回 varchar2/number/date

CREATE OR REPLACE PACKAGE util_pkg AS

    -- 包级全局(刻意暴露在 spec，body 初始化块填充；sql2java 不能错翻成 static 常量)
    g_curr_biz_date  DATE;
    g_last_biz_date  DATE;
    g_next_biz_date  DATE;
    g_curr_operator  VARCHAR2(32);
    g_session_id     VARCHAR2(64);

    -- 条件编译开关: 静态布尔常量，body 里用 $IF util_pkg.c_trace_compile $THEN ... 控制是否编进 trace 代码
    -- 生产编译为 false，trace 代码不进字节码；排障时改 true 重编
    c_trace_compile  CONSTANT BOOLEAN := FALSE;

    PROCEDURE refresh_biz_date;
    FUNCTION  curr_biz_date RETURN DATE;
    FUNCTION  last_biz_date RETURN DATE;
    FUNCTION  next_biz_date RETURN DATE;

    PROCEDURE set_operator(p_operator IN VARCHAR2);
    FUNCTION  get_operator RETURN VARCHAR2;

    -- 参数读取重载: 按默认值类型分派(overload by parameter type)
    FUNCTION get_param(p_key IN VARCHAR2, p_default IN VARCHAR2) RETURN VARCHAR2;
    FUNCTION get_param(p_key IN VARCHAR2, p_default IN NUMBER)   RETURN NUMBER;
    FUNCTION get_param(p_key IN VARCHAR2, p_default IN DATE)     RETURN DATE;

    -- 单据号: 前缀 + YYYYMMDD + 序列后 6 位
    FUNCTION gen_doc_no(p_prefix IN VARCHAR2, p_seq IN NUMBER, p_date IN DATE DEFAULT NULL) RETURN VARCHAR2;

    -- 单位换算(跨 category 抛 e_uom_incompatible)，deterministic 供 SQL 调用
    FUNCTION convert_qty(p_qty IN NUMBER, p_from_uom IN VARCHAR2, p_to_uom IN VARCHAR2) RETURN NUMBER;

    -- 数量按物料基本单位小数位规整
    FUNCTION round_qty(p_qty IN NUMBER, p_uom IN VARCHAR2) RETURN NUMBER;

    FUNCTION format_qty(p_qty IN NUMBER, p_uom IN VARCHAR2 DEFAULT NULL) RETURN VARCHAR2;

    PROCEDURE clear_cache;

END util_pkg;
/

CREATE OR REPLACE PACKAGE BODY util_pkg AS

    -- 单位小数位缓存，按 uom_code 索引，首次用到时懒加载
    TYPE t_uom_digits IS TABLE OF NUMBER INDEX BY VARCHAR2(8);
    g_uom_digits t_uom_digits;

    -- 单位所属 category 缓存，convert_qty 用来判同类
    TYPE t_uom_cat IS TABLE OF VARCHAR2(8) INDEX BY VARCHAR2(8);
    g_uom_cat t_uom_cat;


    PROCEDURE load_uom_cache IS
    BEGIN
        g_uom_digits.DELETE;
        g_uom_cat.DELETE;
        FOR r IN (SELECT uom_code, uom_category, decimal_digits FROM t_uom) LOOP
            g_uom_digits(r.uom_code) := r.decimal_digits;
            g_uom_cat(r.uom_code)    := r.uom_category;
        END LOOP;
    END load_uom_cache;


    PROCEDURE refresh_biz_date IS
    BEGIN
        SELECT curr_biz_date, last_biz_date, next_biz_date
          INTO g_curr_biz_date, g_last_biz_date, g_next_biz_date
          FROM t_business_date
         WHERE sys_code = 'CORE';
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_system, const_pkg.c_mod_util, 'refresh_biz_date',
                '业务日期表 t_business_date(sys_code=CORE) 未初始化');
    END refresh_biz_date;


    FUNCTION curr_biz_date RETURN DATE IS
    BEGIN
        IF g_curr_biz_date IS NULL THEN
            refresh_biz_date;
        END IF;
        RETURN g_curr_biz_date;
    END curr_biz_date;


    FUNCTION last_biz_date RETURN DATE IS
    BEGIN
        IF g_last_biz_date IS NULL THEN
            refresh_biz_date;
        END IF;
        RETURN g_last_biz_date;
    END last_biz_date;


    FUNCTION next_biz_date RETURN DATE IS
    BEGIN
        IF g_next_biz_date IS NULL THEN
            refresh_biz_date;
        END IF;
        RETURN g_next_biz_date;
    END next_biz_date;


    PROCEDURE set_operator(p_operator IN VARCHAR2) IS
    BEGIN
        g_curr_operator := NVL(p_operator, 'SYSTEM');
    END set_operator;


    FUNCTION get_operator RETURN VARCHAR2 IS
    BEGIN
        RETURN NVL(g_curr_operator, NVL(SYS_CONTEXT('userenv','session_user'), 'SYSTEM'));
    END get_operator;


    FUNCTION get_param(p_key IN VARCHAR2, p_default IN VARCHAR2) RETURN VARCHAR2 IS
        v_val t_app_param.param_value%TYPE;
    BEGIN
        SELECT param_value INTO v_val FROM t_app_param WHERE param_key = p_key;
        RETURN NVL(v_val, p_default);
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            RETURN p_default;
    END get_param;


    FUNCTION get_param(p_key IN VARCHAR2, p_default IN NUMBER) RETURN NUMBER IS
        v_val t_app_param.param_value%TYPE;
    BEGIN
        SELECT param_value INTO v_val FROM t_app_param WHERE param_key = p_key;
        RETURN NVL(TO_NUMBER(v_val), p_default);
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            RETURN p_default;
        WHEN VALUE_ERROR THEN
            -- 配错成非数字时退回默认值并告警，不让跑批因一个脏参数崩掉
            exc_pkg.log_error(
                const_pkg.c_err_system, const_pkg.c_mod_util, 'get_param',
                '参数非数字 key=' || p_key || ' val=' || v_val, p_key, NULL, 'WARN');
            RETURN p_default;
    END get_param;


    FUNCTION get_param(p_key IN VARCHAR2, p_default IN DATE) RETURN DATE IS
        v_val t_app_param.param_value%TYPE;
    BEGIN
        SELECT param_value INTO v_val FROM t_app_param WHERE param_key = p_key;
        RETURN NVL(TO_DATE(v_val, 'YYYY-MM-DD'), p_default);
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            RETURN p_default;
    END get_param;


    FUNCTION gen_doc_no(p_prefix IN VARCHAR2, p_seq IN NUMBER, p_date IN DATE DEFAULT NULL) RETURN VARCHAR2 IS
    BEGIN
        RETURN p_prefix || TO_CHAR(NVL(p_date, curr_biz_date), 'YYYYMMDD')
            || LPAD(MOD(p_seq, 1000000), 6, '0');
    END gen_doc_no;


    FUNCTION convert_qty(p_qty IN NUMBER, p_from_uom IN VARCHAR2, p_to_uom IN VARCHAR2) RETURN NUMBER IS
        v_factor NUMBER;
    BEGIN
        IF p_from_uom = p_to_uom OR p_qty IS NULL THEN
            RETURN p_qty;
        END IF;

        IF g_uom_cat.COUNT = 0 THEN
            load_uom_cache;
        END IF;

        -- 跨类换算无意义(重量换不成长度)，直接拦
        IF NOT (g_uom_cat.EXISTS(p_from_uom) AND g_uom_cat.EXISTS(p_to_uom)) THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_uom_not_found, const_pkg.c_mod_util, 'convert_qty',
                '单位未定义 from=' || p_from_uom || ' to=' || p_to_uom, p_from_uom);
        END IF;
        IF g_uom_cat(p_from_uom) <> g_uom_cat(p_to_uom) THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_uom_incompatible, const_pkg.c_mod_util, 'convert_qty',
                '单位不同类不可换算 ' || p_from_uom || '(' || g_uom_cat(p_from_uom) || ') -> '
                || p_to_uom || '(' || g_uom_cat(p_to_uom) || ')', p_from_uom);
        END IF;

        $IF util_pkg.c_trace_compile $THEN
            DBMS_OUTPUT.PUT_LINE('[TRACE] convert_qty ' || p_qty || ' ' || p_from_uom || '->' || p_to_uom);
        $END

        BEGIN
            SELECT factor INTO v_factor
              FROM t_uom_conversion
             WHERE from_uom = p_from_uom AND to_uom = p_to_uom;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                -- 同类但缺直接换算系数，回退按基本单位枢轴折算
                SELECT f.factor / t.factor
                  INTO v_factor
                  FROM t_uom_conversion f
                  JOIN t_uom_conversion t ON t.from_uom = p_to_uom AND t.to_uom = f.to_uom
                 WHERE f.from_uom = p_from_uom
                   AND ROWNUM = 1;
        END;

        RETURN round_qty(p_qty * v_factor, p_to_uom);
    END convert_qty;


    FUNCTION round_qty(p_qty IN NUMBER, p_uom IN VARCHAR2) RETURN NUMBER IS
        v_digits NUMBER;
    BEGIN
        IF p_qty IS NULL THEN
            RETURN NULL;
        END IF;
        IF g_uom_digits.COUNT = 0 THEN
            load_uom_cache;
        END IF;
        v_digits := CASE WHEN g_uom_digits.EXISTS(p_uom) THEN g_uom_digits(p_uom) ELSE 4 END;
        RETURN ROUND(p_qty, v_digits);
    END round_qty;


    FUNCTION format_qty(p_qty IN NUMBER, p_uom IN VARCHAR2 DEFAULT NULL) RETURN VARCHAR2 IS
        v_digits NUMBER;
        v_fmt    VARCHAR2(40);
    BEGIN
        IF p_qty IS NULL THEN
            RETURN NULL;
        END IF;
        IF g_uom_digits.COUNT = 0 THEN
            load_uom_cache;
        END IF;
        v_digits := CASE WHEN p_uom IS NOT NULL AND g_uom_digits.EXISTS(p_uom)
                         THEN g_uom_digits(p_uom) ELSE 2 END;
        v_fmt := 'FM999,999,999,990'
              || CASE WHEN v_digits > 0 THEN '.' || RPAD('0', v_digits, '0') END;
        RETURN TRIM(TO_CHAR(ROUND(p_qty, v_digits), v_fmt))
            || CASE WHEN p_uom IS NOT NULL THEN ' ' || p_uom END;
    END format_qty;


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
            DBMS_OUTPUT.PUT_LINE('[WARN] util_pkg init partially failed: ' || SQLERRM);
    END;
END util_pkg;
/
