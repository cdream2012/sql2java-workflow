-- BOM 展开结果行类型 + 嵌套表，给 bom_pkg 的 pipelined 函数用
-- pipelined 让递归展开能边算边吐行，调用方 select * from table(bom_pkg.explode(...)) 流式消费
-- path 用 sys_connect_by_path 风格的 /a/b/c，cum_qty 是从顶层累乘下来的总需用量

CREATE OR REPLACE TYPE t_explosion_row FORCE AS OBJECT (
    lvl                 NUMBER,
    parent_item_id      NUMBER(18),
    component_item_id   NUMBER(18),
    component_code      VARCHAR2(40),
    component_name      VARCHAR2(200),
    item_type           VARCHAR2(8),
    qty_per             NUMBER(18,6),
    cum_qty             NUMBER(18,6),
    uom                 VARCHAR2(8),
    path                VARCHAR2(1000),
    is_leaf             VARCHAR2(1),
    is_phantom          VARCHAR2(1)
);
/

CREATE OR REPLACE TYPE t_explosion_tab FORCE AS TABLE OF t_explosion_row;
/
