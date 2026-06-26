-- BOM 单位成本卷算(递归独立函数)
-- 沿 BOM 树自底向上递归: 叶子(无生效 BOM 的原料/服务)取标准成本，装配件累加子件成本
-- 与 bom_pkg.rolled_cost 同口径，但做成独立递归函数便于 SQL 里逐料 select 调用:
--   select item_code, fn_bom_unit_cost(item_id) from t_item where item_type='FG'
-- install 时本函数在包之后加载，故包体不依赖它(包内自带等价递归)，避免编译顺序问题
-- 含损耗用量 = qty_per / (1 - scrap_rate)，与 t_bom_comp_obj.effective_qty 一致

CREATE OR REPLACE FUNCTION fn_bom_unit_cost(
    p_item_id IN NUMBER,
    p_as_of   IN DATE DEFAULT NULL
) RETURN NUMBER IS
    v_dt       DATE := NVL(p_as_of, SYSDATE);
    v_bom_id   NUMBER;
    v_base_qty NUMBER;
    v_total    NUMBER := 0;
BEGIN
    BEGIN
        SELECT bom_id, base_qty
          INTO v_bom_id, v_base_qty
          FROM (
                SELECT bom_id, base_qty
                  FROM t_bom_header
                 WHERE item_id = p_item_id
                   AND status  = 'ACTIVE'
                   AND is_default = 'Y'
                   AND effective_from <= v_dt
                   AND (effective_to IS NULL OR effective_to >= v_dt)
                 ORDER BY effective_from DESC
               )
         WHERE ROWNUM = 1;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            -- 叶子: 没有生效 BOM，单位成本就是它自己的标准成本
            SELECT std_cost INTO v_total FROM t_item WHERE item_id = p_item_id;
            RETURN v_total;
    END;

    FOR c IN (
        SELECT component_item_id, qty_per, scrap_rate
          FROM t_bom_line
         WHERE bom_id = v_bom_id
    ) LOOP
        v_total := v_total
                 + fn_bom_unit_cost(c.component_item_id, v_dt)
                   * (c.qty_per / (1 - NVL(c.scrap_rate, 0)));
    END LOOP;

    RETURN ROUND(v_total / NULLIF(v_base_qty, 0), 6);
END fn_bom_unit_cost;
/
