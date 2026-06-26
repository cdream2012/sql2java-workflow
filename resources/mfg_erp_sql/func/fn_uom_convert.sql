-- 单位换算(SQL 友好独立版)
-- 同 util_pkg.convert_qty，但暴露成独立 deterministic 函数便于报表里直接 select 调用:
--   select fn_uom_convert(1.5, 'KG', 'G') from dual
-- 跨类换算返回 null(不抛异常，报表场景更宽容)，命中不到换算系数也返回 null

CREATE OR REPLACE FUNCTION fn_uom_convert(
    p_qty      IN NUMBER,
    p_from_uom IN VARCHAR2,
    p_to_uom   IN VARCHAR2
) RETURN NUMBER DETERMINISTIC IS
    v_factor   NUMBER;
    v_from_cat VARCHAR2(8);
    v_to_cat   VARCHAR2(8);
BEGIN
    IF p_qty IS NULL OR p_from_uom IS NULL OR p_to_uom IS NULL THEN
        RETURN p_qty;
    END IF;
    IF p_from_uom = p_to_uom THEN
        RETURN p_qty;
    END IF;

    SELECT MAX(CASE WHEN uom_code = p_from_uom THEN uom_category END),
           MAX(CASE WHEN uom_code = p_to_uom   THEN uom_category END)
      INTO v_from_cat, v_to_cat
      FROM t_uom
     WHERE uom_code IN (p_from_uom, p_to_uom);

    IF v_from_cat IS NULL OR v_to_cat IS NULL OR v_from_cat <> v_to_cat THEN
        RETURN NULL;
    END IF;

    BEGIN
        SELECT factor INTO v_factor
          FROM t_uom_conversion
         WHERE from_uom = p_from_uom AND to_uom = p_to_uom;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            RETURN NULL;
    END;

    RETURN p_qty * v_factor;
END fn_uom_convert;
/
