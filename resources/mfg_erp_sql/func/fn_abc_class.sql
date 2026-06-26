-- 按累计占比定 ABC 等级
-- 阈值默认 80%/95%(帕累托经验值)，调用方可传入覆盖
-- 抽成独立函数是因为 report_pkg 帕累托报表与 item_pkg.reclassify_abc 两处都要同一套判级口径

CREATE OR REPLACE FUNCTION fn_abc_class(
    p_cum_pct IN NUMBER,
    p_a_pct   IN NUMBER DEFAULT 0.80,
    p_b_pct   IN NUMBER DEFAULT 0.95
) RETURN VARCHAR2 DETERMINISTIC IS
BEGIN
    IF p_cum_pct IS NULL THEN
        RETURN NULL;
    END IF;
    IF p_cum_pct <= p_a_pct THEN
        RETURN 'A';
    ELSIF p_cum_pct <= p_b_pct THEN
        RETURN 'B';
    ELSE
        RETURN 'C';
    END IF;
END fn_abc_class;
/
