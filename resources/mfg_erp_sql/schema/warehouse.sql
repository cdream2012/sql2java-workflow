-- 仓库 + 库位
-- 库位 t_location 自带父子(库区->货架->货位)，用 parent_location_id 自引用
-- 目前业务只用到两层，但表结构留了任意层级，盘点/拣货路径将来按树遍历

CREATE TABLE t_warehouse (
    warehouse_id    NUMBER(18)     NOT NULL,
    warehouse_code  VARCHAR2(16)   NOT NULL,
    warehouse_name  VARCHAR2(100)  NOT NULL,
    warehouse_type  VARCHAR2(8)    DEFAULT 'FG' NOT NULL,
    region          VARCHAR2(32),
    is_active       CHAR(1)        DEFAULT 'Y' NOT NULL,
    created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_warehouse PRIMARY KEY (warehouse_id),
    CONSTRAINT uk_warehouse_code UNIQUE (warehouse_code),
    CONSTRAINT ck_wh_type   CHECK (warehouse_type IN ('RAW','FG','WIP','RET')),
    CONSTRAINT ck_wh_active  CHECK (is_active IN ('Y','N'))
);

COMMENT ON COLUMN t_warehouse.warehouse_type IS 'RAW 原料 / FG 成品 / WIP 在制 / RET 退货';


CREATE TABLE t_location (
    location_id         NUMBER(18)     NOT NULL,
    warehouse_id        NUMBER(18)     NOT NULL,
    parent_location_id  NUMBER(18),
    location_code       VARCHAR2(32)   NOT NULL,
    zone                VARCHAR2(16),
    is_pickable         CHAR(1)        DEFAULT 'Y' NOT NULL,
    CONSTRAINT pk_location PRIMARY KEY (location_id),
    CONSTRAINT uk_location_code UNIQUE (warehouse_id, location_code),
    CONSTRAINT fk_location_wh     FOREIGN KEY (warehouse_id)       REFERENCES t_warehouse(warehouse_id),
    CONSTRAINT fk_location_parent FOREIGN KEY (parent_location_id) REFERENCES t_location(location_id),
    CONSTRAINT ck_location_pick   CHECK (is_pickable IN ('Y','N'))
);
