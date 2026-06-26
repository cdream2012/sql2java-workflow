-- 采购订单 + 销售订单(各自头/行)
-- 状态机由 procurement_pkg / 销售侧维护，行状态汇总驱动头状态:
--   PO: DRAFT -> APPROVED -> PARTIAL -> RECEIVED -> CLOSED (可 CANCELLED)
--   行 qty_received 累加到等于 qty_ordered 时行 CLOSED，全行 CLOSED 头 RECEIVED
-- 收货过账走 inventory_pkg.receive_po，库存与 PO 行的 qty_received 在同一事务更新

CREATE TABLE t_purchase_order (
    po_id           NUMBER(18)     NOT NULL,
    po_no           VARCHAR2(32)   NOT NULL,
    supplier_id     NUMBER(18)     NOT NULL,
    order_date      DATE           DEFAULT SYSDATE NOT NULL,
    expected_date   DATE,
    status          VARCHAR2(12)   DEFAULT 'DRAFT' NOT NULL,
    currency_code   VARCHAR2(8)    DEFAULT 'CNY' NOT NULL,
    total_amount    NUMBER(20,4)   DEFAULT 0 NOT NULL,
    warehouse_id    NUMBER(18),
    created_by      VARCHAR2(32)   DEFAULT 'SYSTEM' NOT NULL,
    approved_by     VARCHAR2(32),
    approved_at     TIMESTAMP,
    created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_purchase_order PRIMARY KEY (po_id),
    CONSTRAINT uk_po_no UNIQUE (po_no),
    CONSTRAINT fk_po_supplier FOREIGN KEY (supplier_id)  REFERENCES t_supplier(supplier_id),
    CONSTRAINT fk_po_wh       FOREIGN KEY (warehouse_id) REFERENCES t_warehouse(warehouse_id),
    CONSTRAINT ck_po_status CHECK (status IN ('DRAFT','APPROVED','PARTIAL','RECEIVED','CLOSED','CANCELLED'))
);


CREATE TABLE t_po_line (
    po_line_id     NUMBER(18)     NOT NULL,
    po_id          NUMBER(18)     NOT NULL,
    line_no        NUMBER(6)      NOT NULL,
    item_id        NUMBER(18)     NOT NULL,
    qty_ordered    NUMBER(18,4)   NOT NULL,
    qty_received   NUMBER(18,4)   DEFAULT 0 NOT NULL,
    unit_price     NUMBER(20,6)   NOT NULL,
    uom            VARCHAR2(8)    NOT NULL,
    need_date      DATE,
    line_status    VARCHAR2(12)   DEFAULT 'OPEN' NOT NULL,
    CONSTRAINT pk_po_line PRIMARY KEY (po_line_id),
    CONSTRAINT uk_po_line UNIQUE (po_id, line_no),
    CONSTRAINT fk_poline_po   FOREIGN KEY (po_id)   REFERENCES t_purchase_order(po_id),
    CONSTRAINT fk_poline_item FOREIGN KEY (item_id) REFERENCES t_item(item_id),
    CONSTRAINT fk_poline_uom  FOREIGN KEY (uom)     REFERENCES t_uom(uom_code),
    CONSTRAINT ck_poline_status CHECK (line_status IN ('OPEN','PARTIAL','CLOSED','CANCELLED')),
    CONSTRAINT ck_poline_qty    CHECK (qty_ordered > 0 AND qty_received >= 0)
);


CREATE TABLE t_sales_order (
    so_id           NUMBER(18)     NOT NULL,
    so_no           VARCHAR2(32)   NOT NULL,
    customer_id     NUMBER(18)     NOT NULL,
    order_date      DATE           DEFAULT SYSDATE NOT NULL,
    required_date   DATE,
    status          VARCHAR2(12)   DEFAULT 'DRAFT' NOT NULL,
    currency_code   VARCHAR2(8)    DEFAULT 'CNY' NOT NULL,
    price_list_id   NUMBER(18),
    total_amount    NUMBER(20,4)   DEFAULT 0 NOT NULL,
    warehouse_id    NUMBER(18),
    created_by      VARCHAR2(32)   DEFAULT 'SYSTEM' NOT NULL,
    created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_sales_order PRIMARY KEY (so_id),
    CONSTRAINT uk_so_no UNIQUE (so_no),
    CONSTRAINT fk_so_customer FOREIGN KEY (customer_id)  REFERENCES t_customer(customer_id),
    CONSTRAINT fk_so_wh       FOREIGN KEY (warehouse_id) REFERENCES t_warehouse(warehouse_id),
    CONSTRAINT ck_so_status CHECK (status IN ('DRAFT','CONFIRMED','PARTIAL','SHIPPED','CLOSED','CANCELLED'))
);


CREATE TABLE t_so_line (
    so_line_id     NUMBER(18)     NOT NULL,
    so_id          NUMBER(18)     NOT NULL,
    line_no        NUMBER(6)      NOT NULL,
    item_id        NUMBER(18)     NOT NULL,
    qty_ordered    NUMBER(18,4)   NOT NULL,
    qty_shipped    NUMBER(18,4)   DEFAULT 0 NOT NULL,
    unit_price     NUMBER(20,6)   NOT NULL,
    discount_pct   NUMBER(8,4)    DEFAULT 0 NOT NULL,
    uom            VARCHAR2(8)    NOT NULL,
    line_status    VARCHAR2(12)   DEFAULT 'OPEN' NOT NULL,
    CONSTRAINT pk_so_line PRIMARY KEY (so_line_id),
    CONSTRAINT uk_so_line UNIQUE (so_id, line_no),
    CONSTRAINT fk_soline_so   FOREIGN KEY (so_id)   REFERENCES t_sales_order(so_id),
    CONSTRAINT fk_soline_item FOREIGN KEY (item_id) REFERENCES t_item(item_id),
    CONSTRAINT fk_soline_uom  FOREIGN KEY (uom)     REFERENCES t_uom(uom_code),
    CONSTRAINT ck_soline_status CHECK (line_status IN ('OPEN','PARTIAL','CLOSED','CANCELLED')),
    CONSTRAINT ck_soline_disc   CHECK (discount_pct >= 0 AND discount_pct < 1)
);
