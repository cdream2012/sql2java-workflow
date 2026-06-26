-- 库存: 批次明细 + 余额汇总 + 流水
-- 三层结构的原因:
--   批次 t_inventory_lot   -> FIFO 估值要按批次入库时间排队扣减，必须保留批次粒度
--   余额 t_inventory_balance-> 物料+仓库维度的快照，可用量校验走它，避免每次 sum 批次
--   流水 t_inventory_txn    -> 不可变的事件流，余额与批次都是流水的投影，对账以流水为准
-- 批次余额一致性由 inventory_pkg 维护，复合触发器 trg_inv_txn 在流水落库时同步余额

CREATE TABLE t_inventory_lot (
    lot_id          NUMBER(18)     NOT NULL,
    lot_no          VARCHAR2(40)   NOT NULL,
    item_id         NUMBER(18)     NOT NULL,
    warehouse_id    NUMBER(18)     NOT NULL,
    qty_on_hand     NUMBER(18,4)   DEFAULT 0 NOT NULL,
    qty_allocated   NUMBER(18,4)   DEFAULT 0 NOT NULL,
    unit_cost       NUMBER(20,6)   DEFAULT 0 NOT NULL,
    currency_code   VARCHAR2(8)    DEFAULT 'CNY' NOT NULL,
    receipt_date    DATE           NOT NULL,
    expiry_date     DATE,
    status          VARCHAR2(12)   DEFAULT 'AVAILABLE' NOT NULL,
    source_doc_type VARCHAR2(16),
    source_doc_id   NUMBER(18),
    created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_inventory_lot PRIMARY KEY (lot_id),
    CONSTRAINT uk_inv_lot_no UNIQUE (lot_no),
    CONSTRAINT fk_lot_item FOREIGN KEY (item_id)      REFERENCES t_item(item_id),
    CONSTRAINT fk_lot_wh   FOREIGN KEY (warehouse_id) REFERENCES t_warehouse(warehouse_id),
    CONSTRAINT ck_lot_status CHECK (status IN ('AVAILABLE','QUARANTINE','EXPIRED','CONSUMED')),
    CONSTRAINT ck_lot_qty    CHECK (qty_on_hand >= 0 AND qty_allocated >= 0)
);

COMMENT ON COLUMN t_inventory_lot.qty_allocated IS '已分配未发出量，可用 = qty_on_hand - qty_allocated';
COMMENT ON COLUMN t_inventory_lot.receipt_date IS 'FIFO 排队键，同日按 lot_id 升序';


-- 余额汇总，物料+仓库唯一，乐观锁 version
CREATE TABLE t_inventory_balance (
    item_id         NUMBER(18)     NOT NULL,
    warehouse_id    NUMBER(18)     NOT NULL,
    qty_on_hand     NUMBER(18,4)   DEFAULT 0 NOT NULL,
    qty_allocated   NUMBER(18,4)   DEFAULT 0 NOT NULL,
    avg_cost        NUMBER(20,6)   DEFAULT 0 NOT NULL,
    last_txn_date   DATE,
    version         NUMBER(10)     DEFAULT 0 NOT NULL,
    updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_inventory_balance PRIMARY KEY (item_id, warehouse_id),
    CONSTRAINT fk_invbal_item FOREIGN KEY (item_id)      REFERENCES t_item(item_id),
    CONSTRAINT fk_invbal_wh   FOREIGN KEY (warehouse_id) REFERENCES t_warehouse(warehouse_id),
    CONSTRAINT ck_invbal_qty  CHECK (qty_on_hand >= 0)
);

COMMENT ON COLUMN t_inventory_balance.avg_cost IS '移动加权平均成本，AVG 估值物料用；FIFO 物料此列仅作参考';


-- 库存流水，按季分区(与 bank 的 txn 同策略)，分区键 txn_date 入主键
CREATE TABLE t_inventory_txn (
    txn_id          NUMBER(18)     NOT NULL,
    txn_no          VARCHAR2(40)   NOT NULL,
    item_id         NUMBER(18)     NOT NULL,
    warehouse_id    NUMBER(18)     NOT NULL,
    lot_id          NUMBER(18),
    txn_type        VARCHAR2(12)   NOT NULL,
    direction       CHAR(1)        NOT NULL,
    quantity        NUMBER(18,4)   NOT NULL,
    unit_cost       NUMBER(20,6)   DEFAULT 0 NOT NULL,
    total_cost      NUMBER(20,4)   DEFAULT 0 NOT NULL,
    qty_before      NUMBER(18,4),
    qty_after       NUMBER(18,4),
    txn_date        DATE           NOT NULL,
    txn_time        TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    ref_doc_type    VARCHAR2(16),
    ref_doc_id      NUMBER(18),
    operator        VARCHAR2(32)   DEFAULT 'SYSTEM' NOT NULL,
    remark          VARCHAR2(200),
    created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_inventory_txn PRIMARY KEY (txn_id, txn_date),
    CONSTRAINT uk_inv_txn_no UNIQUE (txn_no, txn_date),
    CONSTRAINT ck_invtxn_dir   CHECK (direction IN ('I','O')),
    CONSTRAINT ck_invtxn_type  CHECK (txn_type IN ('RECV','ISSUE','ADJ','XFER_IN','XFER_OUT','PROD_IN','PROD_OUT','RETURN')),
    CONSTRAINT ck_invtxn_qty   CHECK (quantity > 0)
)
PARTITION BY RANGE (txn_date)
(
    PARTITION p_inv_2025q1 VALUES LESS THAN (TO_DATE('2025-04-01','YYYY-MM-DD')),
    PARTITION p_inv_2025q2 VALUES LESS THAN (TO_DATE('2025-07-01','YYYY-MM-DD')),
    PARTITION p_inv_2025q3 VALUES LESS THAN (TO_DATE('2025-10-01','YYYY-MM-DD')),
    PARTITION p_inv_2025q4 VALUES LESS THAN (TO_DATE('2026-01-01','YYYY-MM-DD')),
    PARTITION p_inv_2026q1 VALUES LESS THAN (TO_DATE('2026-04-01','YYYY-MM-DD')),
    PARTITION p_inv_2026q2 VALUES LESS THAN (TO_DATE('2026-07-01','YYYY-MM-DD')),
    PARTITION p_inv_2026q3 VALUES LESS THAN (TO_DATE('2026-10-01','YYYY-MM-DD')),
    PARTITION p_inv_2026q4 VALUES LESS THAN (TO_DATE('2027-01-01','YYYY-MM-DD')),
    PARTITION p_inv_max    VALUES LESS THAN (maxvalue)
);

COMMENT ON COLUMN t_inventory_txn.direction IS 'I 入库(数量增) / O 出库(数量减)，与 txn_type 配合';
COMMENT ON COLUMN t_inventory_txn.txn_type  IS 'RECV 收货/ISSUE 发料/ADJ 调整/XFER 调拨/PROD 生产入出/RETURN 退货';
