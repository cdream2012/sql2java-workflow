-- 供应商 + 客户
-- 供应商提前期 lead_time_days 是 MRP 倒排计划的关键输入，rating 影响优选供应商
-- 客户挂 price_list_id，定价引擎优先取客户专属价目表，无则落默认表

CREATE TABLE t_supplier (
    supplier_id     NUMBER(18)     NOT NULL,
    supplier_code   VARCHAR2(32)   NOT NULL,
    supplier_name   VARCHAR2(200)  NOT NULL,
    lead_time_days  NUMBER(5)      DEFAULT 7 NOT NULL,
    rating          NUMBER(2)      DEFAULT 3,
    currency_code   VARCHAR2(8)    DEFAULT 'CNY' NOT NULL,
    tax_no          VARCHAR2(40),
    contact         VARCHAR2(100),
    status          VARCHAR2(8)    DEFAULT 'ACTIVE' NOT NULL,
    created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_supplier PRIMARY KEY (supplier_id),
    CONSTRAINT uk_supplier_code UNIQUE (supplier_code),
    CONSTRAINT ck_supplier_status CHECK (status IN ('ACTIVE','HOLD','BLOCKED')),
    CONSTRAINT ck_supplier_rating CHECK (rating BETWEEN 1 AND 5)
);

COMMENT ON COLUMN t_supplier.rating IS '供应商评级 1-5，5 最优，影响 mrp 优选与对账容忍度';


CREATE TABLE t_customer (
    customer_id     NUMBER(18)     NOT NULL,
    customer_code   VARCHAR2(32)   NOT NULL,
    customer_name   VARCHAR2(200)  NOT NULL,
    price_list_id   NUMBER(18),
    credit_limit    NUMBER(20,4)   DEFAULT 0 NOT NULL,
    currency_code   VARCHAR2(8)    DEFAULT 'CNY' NOT NULL,
    region          VARCHAR2(32),
    status          VARCHAR2(8)    DEFAULT 'ACTIVE' NOT NULL,
    created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_customer PRIMARY KEY (customer_id),
    CONSTRAINT uk_customer_code UNIQUE (customer_code),
    CONSTRAINT ck_customer_status CHECK (status IN ('ACTIVE','HOLD','BLOCKED')),
    CONSTRAINT ck_customer_credit CHECK (credit_limit >= 0)
);
