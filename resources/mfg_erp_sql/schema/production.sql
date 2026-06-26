-- 生产工单 + MRP 运行 + MRP 计划明细
-- 工单领料按 BOM 展开当层组件，完工入成品；领料/入库都走 inventory_pkg 产生 PROD_OUT/PROD_IN 流水
-- MRP 一次运行(t_mrp_run)产出一批计划行(t_mrp_plan)，按物料+时段滚动净算需求

CREATE TABLE t_production_order (
    prod_id         NUMBER(18)     NOT NULL,
    prod_no         VARCHAR2(32)   NOT NULL,
    item_id         NUMBER(18)     NOT NULL,
    bom_id          NUMBER(18),
    qty_planned     NUMBER(18,4)   NOT NULL,
    qty_completed   NUMBER(18,4)   DEFAULT 0 NOT NULL,
    qty_scrapped    NUMBER(18,4)   DEFAULT 0 NOT NULL,
    status          VARCHAR2(12)   DEFAULT 'PLANNED' NOT NULL,
    warehouse_id    NUMBER(18),
    start_date      DATE,
    due_date        DATE,
    source_mrp_id   NUMBER(18),
    created_by      VARCHAR2(32)   DEFAULT 'SYSTEM' NOT NULL,
    created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_production_order PRIMARY KEY (prod_id),
    CONSTRAINT uk_prod_no UNIQUE (prod_no),
    CONSTRAINT fk_prod_item FOREIGN KEY (item_id) REFERENCES t_item(item_id),
    CONSTRAINT fk_prod_bom  FOREIGN KEY (bom_id)  REFERENCES t_bom_header(bom_id),
    CONSTRAINT fk_prod_wh   FOREIGN KEY (warehouse_id) REFERENCES t_warehouse(warehouse_id),
    CONSTRAINT ck_prod_status CHECK (status IN ('PLANNED','RELEASED','IN_PROGRESS','COMPLETED','CLOSED','CANCELLED')),
    CONSTRAINT ck_prod_qty    CHECK (qty_planned > 0)
);


CREATE TABLE t_mrp_run (
    run_id          NUMBER(18)     NOT NULL,
    run_no          VARCHAR2(32)   NOT NULL,
    run_date        DATE           NOT NULL,
    horizon_days    NUMBER(5)      DEFAULT 90 NOT NULL,
    bucket_type     VARCHAR2(8)    DEFAULT 'WEEK' NOT NULL,
    status          VARCHAR2(12)   DEFAULT 'RUNNING' NOT NULL,
    item_count      NUMBER(10)     DEFAULT 0,
    plan_count      NUMBER(10)     DEFAULT 0,
    started_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    finished_at     TIMESTAMP,
    created_by      VARCHAR2(32)   DEFAULT 'SYSTEM' NOT NULL,
    CONSTRAINT pk_mrp_run PRIMARY KEY (run_id),
    CONSTRAINT uk_mrp_run_no UNIQUE (run_no),
    CONSTRAINT ck_mrp_status CHECK (status IN ('RUNNING','SUCCESS','FAILED','PARTIAL')),
    CONSTRAINT ck_mrp_bucket CHECK (bucket_type IN ('DAY','WEEK','MONTH'))
);

COMMENT ON COLUMN t_mrp_run.bucket_type IS '时段粒度，需求/供给按桶滚动净算';


CREATE TABLE t_mrp_plan (
    plan_id            NUMBER(18)     NOT NULL,
    run_id             NUMBER(18)     NOT NULL,
    item_id            NUMBER(18)     NOT NULL,
    warehouse_id       NUMBER(18),
    bucket_date        DATE           NOT NULL,
    level_no           NUMBER(3)      DEFAULT 0 NOT NULL,
    gross_req          NUMBER(18,4)   DEFAULT 0 NOT NULL,
    scheduled_receipt  NUMBER(18,4)   DEFAULT 0 NOT NULL,
    proj_on_hand       NUMBER(18,4)   DEFAULT 0 NOT NULL,
    net_req            NUMBER(18,4)   DEFAULT 0 NOT NULL,
    planned_order_qty  NUMBER(18,4)   DEFAULT 0 NOT NULL,
    planned_order_date DATE,
    action_msg         VARCHAR2(40),
    CONSTRAINT pk_mrp_plan PRIMARY KEY (plan_id),
    CONSTRAINT fk_mrpplan_run  FOREIGN KEY (run_id)  REFERENCES t_mrp_run(run_id),
    CONSTRAINT fk_mrpplan_item FOREIGN KEY (item_id) REFERENCES t_item(item_id)
);

COMMENT ON COLUMN t_mrp_plan.level_no IS 'BOM 低层码(low-level code)，展开层级越深越大，净算必须自顶向下逐层';
COMMENT ON COLUMN t_mrp_plan.action_msg IS '计划建议: 下单/催料/延迟/取消，由净算结果生成';
