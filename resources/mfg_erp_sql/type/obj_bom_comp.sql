-- BOM 单层组件对象 + 嵌套表
-- bom_pkg 比较两个 BOM 版本差异时用 multiset except/intersect，需要可比较的元素类型
-- 元素相等性由 oracle 按对象所有属性逐一比较，这里刻意只放参与"是否同一组件用量"的字段
-- (不含 line_id 这类代理键，否则 multiset 比较永远全不等)

CREATE OR REPLACE TYPE t_bom_comp_obj FORCE AS OBJECT (
    component_item_id   NUMBER(18),
    component_code      VARCHAR2(40),
    qty_per             NUMBER(18,6),
    uom                 VARCHAR2(8),
    scrap_rate          NUMBER(8,4),

    -- 含损耗的实际投料量: qty_per / (1 - scrap_rate)
    MEMBER FUNCTION effective_qty RETURN NUMBER
);
/

CREATE OR REPLACE TYPE BODY t_bom_comp_obj AS

    MEMBER FUNCTION effective_qty RETURN NUMBER IS
    BEGIN
        IF NVL(SELF.scrap_rate, 0) >= 1 THEN
            RAISE_APPLICATION_ERROR(-20901,
                '损耗率不能 >= 1: ' || SELF.component_code || ' scrap=' || SELF.scrap_rate);
        END IF;
        RETURN ROUND(SELF.qty_per / (1 - NVL(SELF.scrap_rate, 0)), 6);
    END effective_qty;

END;
/

CREATE OR REPLACE TYPE t_bom_comp_tab FORCE AS TABLE OF t_bom_comp_obj;
/
