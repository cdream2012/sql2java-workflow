-- 金额值对象
-- 系统里多币种金额到处传，裸 number 容易漏带币种导致跨币种直接相加的事故
-- 把"金额 + 币种"绑成一个对象，加总走 plus() 强制同币种校验
-- map 方法让 t_money 能直接进 order by / 集合排序(只比金额，跨币种比较无意义，调用方自行折算)

CREATE OR REPLACE TYPE t_money FORCE AS OBJECT (
    amount         NUMBER(20,4),
    currency_code  VARCHAR2(8),

    MEMBER FUNCTION plus(p_other IN t_money) RETURN t_money,
    MEMBER FUNCTION minus(p_other IN t_money) RETURN t_money,
    MEMBER FUNCTION scale_by(p_factor IN NUMBER) RETURN t_money,
    MEMBER FUNCTION is_zero RETURN VARCHAR2,
    MEMBER FUNCTION abs_value RETURN t_money,
    MEMBER FUNCTION to_display RETURN VARCHAR2,

    -- 排序键：仅取金额，币种维度由业务层折算后再比
    MAP MEMBER FUNCTION sort_key RETURN NUMBER
);
/

CREATE OR REPLACE TYPE BODY t_money AS

    MEMBER FUNCTION plus(p_other IN t_money) RETURN t_money IS
    BEGIN
        IF p_other IS NULL THEN
            RETURN SELF;
        END IF;
        IF SELF.currency_code <> p_other.currency_code THEN
            RAISE_APPLICATION_ERROR(-20900,
                '金额相加币种不一致: ' || SELF.currency_code || ' vs ' || p_other.currency_code);
        END IF;
        RETURN t_money(SELF.amount + p_other.amount, SELF.currency_code);
    END plus;

    MEMBER FUNCTION minus(p_other IN t_money) RETURN t_money IS
    BEGIN
        RETURN SELF.plus(t_money(-p_other.amount, p_other.currency_code));
    END minus;

    MEMBER FUNCTION scale_by(p_factor IN NUMBER) RETURN t_money IS
    BEGIN
        RETURN t_money(ROUND(SELF.amount * NVL(p_factor, 0), 4), SELF.currency_code);
    END scale_by;

    MEMBER FUNCTION is_zero RETURN VARCHAR2 IS
    BEGIN
        RETURN CASE WHEN NVL(SELF.amount, 0) = 0 THEN 'Y' ELSE 'N' END;
    END is_zero;

    MEMBER FUNCTION abs_value RETURN t_money IS
    BEGIN
        RETURN t_money(ABS(SELF.amount), SELF.currency_code);
    END abs_value;

    MEMBER FUNCTION to_display RETURN VARCHAR2 IS
    BEGIN
        RETURN TO_CHAR(SELF.amount, 'FM999,999,999,990.0000') || ' ' || SELF.currency_code;
    END to_display;

    MAP MEMBER FUNCTION sort_key RETURN NUMBER IS
    BEGIN
        RETURN NVL(SELF.amount, 0);
    END sort_key;

END;
/
