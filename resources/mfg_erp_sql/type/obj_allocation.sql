-- 库存批次分配对象 + 嵌套表
-- FIFO 发料时一次出库可能跨多个批次，结果是"每批扣多少、单价多少"的列表
-- inventory_pkg.issue_stock 返回 t_alloc_tab，上层据此生成多条库存流水与成本分摊

CREATE OR REPLACE TYPE t_alloc_obj FORCE AS OBJECT (
    lot_id       NUMBER(18),
    lot_no       VARCHAR2(40),
    alloc_qty    NUMBER(18,4),
    unit_cost    NUMBER(20,6),

    MEMBER FUNCTION alloc_cost RETURN NUMBER
);
/

CREATE OR REPLACE TYPE BODY t_alloc_obj AS

    MEMBER FUNCTION alloc_cost RETURN NUMBER IS
    BEGIN
        RETURN ROUND(NVL(SELF.alloc_qty, 0) * NVL(SELF.unit_cost, 0), 4);
    END alloc_cost;

END;
/

CREATE OR REPLACE TYPE t_alloc_tab FORCE AS TABLE OF t_alloc_obj;
/
