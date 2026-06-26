-- 物料分类树 + 物料主表
-- 分类树 t_item_category 自引用 parent_category_id，根节点 parent 为 null
-- level_no / path 是冗余的展开缓存(由 CONNECT BY 维护)，查询时不必每次递归
-- 留这两列是因为分类层级深(最多 5 层)，报表按某节点取整棵子树非常频繁

CREATE TABLE t_item_category (
    category_id         NUMBER(18)     NOT NULL,
    parent_category_id  NUMBER(18),
    category_code       VARCHAR2(32)   NOT NULL,
    category_name       VARCHAR2(100)  NOT NULL,
    level_no            NUMBER(3)      DEFAULT 1 NOT NULL,
    path                VARCHAR2(500),
    is_leaf             CHAR(1)        DEFAULT 'Y' NOT NULL,
    CONSTRAINT pk_item_category PRIMARY KEY (category_id),
    CONSTRAINT uk_item_category_code UNIQUE (category_code),
    CONSTRAINT fk_category_parent FOREIGN KEY (parent_category_id) REFERENCES t_item_category(category_id),
    CONSTRAINT ck_category_leaf CHECK (is_leaf IN ('Y','N'))
);

COMMENT ON COLUMN t_item_category.path IS '从根到本节点的 /code/code/code 路径，CONNECT BY sys_connect_by_path 维护';


-- 物料主表
-- item_type 决定走哪类业务逻辑，与对象层 t_item_obj 子型一一对应:
--   RAW 原材料 / SEMI 半成品 / FG 成品 / SVC 服务(委外/运费,不可库存)
-- is_phantom: 虚拟件(幻影件)，自身不入库，BOM 展开时直接穿透到其下层组件
--   常见于"包装组件""通用支架"这类只为整理 BOM 结构、不单独领料的层级
-- dim / tags 用对象列与 varray 列内嵌存储，刻意让 sql2java 处理对象/集合列映射
CREATE TABLE t_item (
    item_id              NUMBER(18)     NOT NULL,
    item_code            VARCHAR2(40)   NOT NULL,
    item_name            VARCHAR2(200)  NOT NULL,
    item_type            VARCHAR2(8)    DEFAULT 'RAW' NOT NULL,
    category_id          NUMBER(18),
    base_uom             VARCHAR2(8)    NOT NULL,
    std_cost             NUMBER(20,6)   DEFAULT 0 NOT NULL,
    list_price           NUMBER(20,4)   DEFAULT 0 NOT NULL,
    currency_code        VARCHAR2(8)    DEFAULT 'CNY' NOT NULL,
    valuation_method     VARCHAR2(8)    DEFAULT 'FIFO' NOT NULL,
    preferred_supplier   NUMBER(18),
    lead_time_days       NUMBER(5)      DEFAULT 0 NOT NULL,
    safety_stock         NUMBER(18,4)   DEFAULT 0 NOT NULL,
    reorder_point        NUMBER(18,4)   DEFAULT 0 NOT NULL,
    reorder_qty          NUMBER(18,4)   DEFAULT 0 NOT NULL,
    shelf_life_days      NUMBER(6),
    abc_class            CHAR(1),
    is_phantom           CHAR(1)        DEFAULT 'N' NOT NULL,
    is_lot_controlled    CHAR(1)        DEFAULT 'Y' NOT NULL,
    status               VARCHAR2(8)    DEFAULT 'ACTIVE' NOT NULL,
    dim                  t_dimension,
    tags                 t_tag_varray,
    created_by           VARCHAR2(32)   DEFAULT 'SYSTEM' NOT NULL,
    created_at           TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_by           VARCHAR2(32),
    updated_at           TIMESTAMP,
    CONSTRAINT pk_item PRIMARY KEY (item_id),
    CONSTRAINT uk_item_code UNIQUE (item_code),
    CONSTRAINT fk_item_category FOREIGN KEY (category_id) REFERENCES t_item_category(category_id),
    CONSTRAINT fk_item_uom      FOREIGN KEY (base_uom)    REFERENCES t_uom(uom_code),
    CONSTRAINT fk_item_supplier FOREIGN KEY (preferred_supplier) REFERENCES t_supplier(supplier_id),
    CONSTRAINT ck_item_type      CHECK (item_type IN ('RAW','SEMI','FG','SVC')),
    CONSTRAINT ck_item_valuation CHECK (valuation_method IN ('FIFO','STD','AVG','NONE')),
    CONSTRAINT ck_item_abc       CHECK (abc_class IN ('A','B','C')),
    CONSTRAINT ck_item_phantom   CHECK (is_phantom IN ('Y','N')),
    CONSTRAINT ck_item_lot       CHECK (is_lot_controlled IN ('Y','N')),
    CONSTRAINT ck_item_status    CHECK (status IN ('ACTIVE','HOLD','OBSOLETE'))
);

COMMENT ON COLUMN t_item.valuation_method IS 'FIFO 先进先出 / STD 标准成本 / AVG 移动加权平均 / NONE 不估值(服务类)';
COMMENT ON COLUMN t_item.abc_class IS 'ABC 分类，由 fn_abc_class 按累计消耗占比定期重算，A 类管控最严';
COMMENT ON COLUMN t_item.is_phantom IS 'Y 虚拟件，BOM 展开穿透不领料；与 item_type=SEMI 可叠加';
