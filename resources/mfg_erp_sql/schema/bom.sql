-- BOM 物料清单: 头(版本) + 行(组件)
-- 一个成品/半成品可有多个版本，同一时点只有一个 ACTIVE 默认版本
-- 多层 BOM 通过"行的组件本身又是另一个 BOM 的头物料"形成树，展开见 bom_pkg
-- 自引用环路(A 用到 B、B 又用到 A)是脏数据，bom_pkg 展开时用 connect by nocycle 兜底并告警

CREATE TABLE t_bom_header (
    bom_id          NUMBER(18)     NOT NULL,
    item_id         NUMBER(18)     NOT NULL,
    bom_version     VARCHAR2(16)   DEFAULT 'V1' NOT NULL,
    base_qty        NUMBER(18,6)   DEFAULT 1 NOT NULL,
    base_uom        VARCHAR2(8)    NOT NULL,
    status          VARCHAR2(8)    DEFAULT 'DRAFT' NOT NULL,
    is_default      CHAR(1)        DEFAULT 'N' NOT NULL,
    effective_from  DATE           DEFAULT SYSDATE NOT NULL,
    effective_to    DATE,
    created_by      VARCHAR2(32)   DEFAULT 'SYSTEM' NOT NULL,
    created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_bom_header PRIMARY KEY (bom_id),
    CONSTRAINT uk_bom_ver UNIQUE (item_id, bom_version),
    CONSTRAINT fk_bom_item FOREIGN KEY (item_id)  REFERENCES t_item(item_id),
    CONSTRAINT fk_bom_uom  FOREIGN KEY (base_uom) REFERENCES t_uom(uom_code),
    CONSTRAINT ck_bom_status  CHECK (status IN ('DRAFT','ACTIVE','OBSOLETE')),
    CONSTRAINT ck_bom_default CHECK (is_default IN ('Y','N')),
    CONSTRAINT ck_bom_baseqty CHECK (base_qty > 0)
);

COMMENT ON COLUMN t_bom_header.base_qty IS '基准产出量，行用量 qty_per 是相对 base_qty 的，比如配 100kg 浆料用 3kg 颜料';


CREATE TABLE t_bom_line (
    line_id            NUMBER(18)     NOT NULL,
    bom_id             NUMBER(18)     NOT NULL,
    line_no            NUMBER(6)      NOT NULL,
    component_item_id  NUMBER(18)     NOT NULL,
    qty_per            NUMBER(18,6)   NOT NULL,
    uom                VARCHAR2(8)    NOT NULL,
    scrap_rate         NUMBER(8,4)    DEFAULT 0 NOT NULL,
    is_phantom         CHAR(1)        DEFAULT 'N' NOT NULL,
    ref_designator     VARCHAR2(100),
    effective_from     DATE           DEFAULT SYSDATE NOT NULL,
    effective_to       DATE,
    CONSTRAINT pk_bom_line PRIMARY KEY (line_id),
    CONSTRAINT uk_bom_line UNIQUE (bom_id, line_no),
    CONSTRAINT fk_bomline_header    FOREIGN KEY (bom_id)            REFERENCES t_bom_header(bom_id),
    CONSTRAINT fk_bomline_component FOREIGN KEY (component_item_id) REFERENCES t_item(item_id),
    CONSTRAINT fk_bomline_uom       FOREIGN KEY (uom)               REFERENCES t_uom(uom_code),
    CONSTRAINT ck_bomline_qty   CHECK (qty_per > 0),
    CONSTRAINT ck_bomline_scrap CHECK (scrap_rate >= 0 AND scrap_rate < 1),
    CONSTRAINT ck_bomline_phantom CHECK (is_phantom IN ('Y','N'))
);

COMMENT ON COLUMN t_bom_line.scrap_rate IS '损耗率，实际投料 = qty_per / (1 - scrap_rate)，见 t_bom_comp_obj.effective_qty';
COMMENT ON COLUMN t_bom_line.is_phantom IS '行级虚拟标志，优先级高于组件物料自身的 is_phantom';
