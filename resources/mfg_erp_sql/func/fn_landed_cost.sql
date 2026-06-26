-- 落地成本(单件)
-- 进口料的真实入库成本 = 采购单价 + 分摊运费 + 关税 + 报关杂费
-- 关税按 (采购价 + 运费) 为完税价乘税率，符合一般到岸价计税口径
-- 报表里按行直接 select 调用，故做成 deterministic 独立函数

CREATE OR REPLACE FUNCTION fn_landed_cost(
    p_unit_price    IN NUMBER,
    p_freight_share IN NUMBER DEFAULT 0,
    p_duty_rate     IN NUMBER DEFAULT 0,
    p_misc_share    IN NUMBER DEFAULT 0
) RETURN NUMBER DETERMINISTIC IS
    v_dutiable NUMBER;
    v_duty     NUMBER;
BEGIN
    IF p_unit_price IS NULL THEN
        RETURN NULL;
    END IF;
    v_dutiable := p_unit_price + NVL(p_freight_share, 0);
    v_duty     := v_dutiable * NVL(p_duty_rate, 0);
    RETURN ROUND(v_dutiable + v_duty + NVL(p_misc_share, 0), 6);
END fn_landed_cost;
/
