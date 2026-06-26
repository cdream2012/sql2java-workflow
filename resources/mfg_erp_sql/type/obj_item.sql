-- 物料对象类型层级，刻意做成继承体系压测 sql2java 的 OOP 映射
-- 基类 t_item_obj 抽象(not instantiable)，三类子型各自覆写估值方法与可库存标志:
--   原材料 RAW  -> FIFO 估值、可库存、按供应商提前期补货
--   成品   FG   -> 标准成本估值、可库存、有 BOM
--   服务   SVC  -> 不可库存、不参与估值(委外加工/运费这类挂账项)
-- valuation_method / is_stockable / lead_time_days 三个方法是上层(costing/mrp)的多态入口
-- 真实库里这些料号在 t_item 表里用 item_type 区分，对象层是给 PL/SQL 内部按多态处理用的

CREATE OR REPLACE TYPE t_item_obj FORCE AS OBJECT (
    item_id     NUMBER(18),
    item_code   VARCHAR2(40),
    item_name   VARCHAR2(200),
    base_uom    VARCHAR2(8),
    std_cost    NUMBER(20,6),

    NOT INSTANTIABLE MEMBER FUNCTION valuation_method RETURN VARCHAR2,
    NOT INSTANTIABLE MEMBER FUNCTION is_stockable RETURN VARCHAR2,
    MEMBER FUNCTION lead_time_days RETURN NUMBER,
    MEMBER FUNCTION describe RETURN VARCHAR2
) NOT INSTANTIABLE NOT FINAL;
/

CREATE OR REPLACE TYPE BODY t_item_obj AS

    -- 默认提前期 0，子类按自身补货特性覆写
    MEMBER FUNCTION lead_time_days RETURN NUMBER IS
    BEGIN
        RETURN 0;
    END lead_time_days;

    MEMBER FUNCTION describe RETURN VARCHAR2 IS
    BEGIN
        RETURN SELF.item_code || ' ' || SELF.item_name
            || ' [' || SELF.valuation_method || '/'
            || CASE SELF.is_stockable WHEN 'Y' THEN '可库存' ELSE '不可库存' END || ']';
    END describe;

END;
/


CREATE OR REPLACE TYPE t_raw_material_obj FORCE UNDER t_item_obj (
    supplier_id      NUMBER(18),
    shelf_life_days  NUMBER,
    reorder_point    NUMBER(18,4),

    OVERRIDING MEMBER FUNCTION valuation_method RETURN VARCHAR2,
    OVERRIDING MEMBER FUNCTION is_stockable RETURN VARCHAR2,
    OVERRIDING MEMBER FUNCTION lead_time_days RETURN NUMBER,
    MEMBER FUNCTION needs_reorder(p_on_hand IN NUMBER) RETURN VARCHAR2
);
/

CREATE OR REPLACE TYPE BODY t_raw_material_obj AS

    OVERRIDING MEMBER FUNCTION valuation_method RETURN VARCHAR2 IS
    BEGIN
        RETURN 'FIFO';
    END valuation_method;

    OVERRIDING MEMBER FUNCTION is_stockable RETURN VARCHAR2 IS
    BEGIN
        RETURN 'Y';
    END is_stockable;

    -- 原材料提前期取供应商档案，缺省 7 天(后面 mrp_pkg 会用实际供应商提前期覆盖)
    OVERRIDING MEMBER FUNCTION lead_time_days RETURN NUMBER IS
    BEGIN
        RETURN 7;
    END lead_time_days;

    MEMBER FUNCTION needs_reorder(p_on_hand IN NUMBER) RETURN VARCHAR2 IS
    BEGIN
        RETURN CASE WHEN NVL(p_on_hand, 0) <= NVL(SELF.reorder_point, 0) THEN 'Y' ELSE 'N' END;
    END needs_reorder;

END;
/


CREATE OR REPLACE TYPE t_finished_good_obj FORCE UNDER t_item_obj (
    bom_id           NUMBER(18),
    make_lead_days   NUMBER,

    OVERRIDING MEMBER FUNCTION valuation_method RETURN VARCHAR2,
    OVERRIDING MEMBER FUNCTION is_stockable RETURN VARCHAR2,
    OVERRIDING MEMBER FUNCTION lead_time_days RETURN NUMBER
);
/

CREATE OR REPLACE TYPE BODY t_finished_good_obj AS

    OVERRIDING MEMBER FUNCTION valuation_method RETURN VARCHAR2 IS
    BEGIN
        RETURN 'STD';
    END valuation_method;

    OVERRIDING MEMBER FUNCTION is_stockable RETURN VARCHAR2 IS
    BEGIN
        RETURN 'Y';
    END is_stockable;

    OVERRIDING MEMBER FUNCTION lead_time_days RETURN NUMBER IS
    BEGIN
        RETURN NVL(SELF.make_lead_days, 1);
    END lead_time_days;

END;
/


CREATE OR REPLACE TYPE t_service_item_obj FORCE UNDER t_item_obj (
    OVERRIDING MEMBER FUNCTION valuation_method RETURN VARCHAR2,
    OVERRIDING MEMBER FUNCTION is_stockable RETURN VARCHAR2
);
/

CREATE OR REPLACE TYPE BODY t_service_item_obj AS

    OVERRIDING MEMBER FUNCTION valuation_method RETURN VARCHAR2 IS
    BEGIN
        RETURN 'NONE';
    END valuation_method;

    OVERRIDING MEMBER FUNCTION is_stockable RETURN VARCHAR2 IS
    BEGIN
        RETURN 'N';
    END is_stockable;

END;
/
