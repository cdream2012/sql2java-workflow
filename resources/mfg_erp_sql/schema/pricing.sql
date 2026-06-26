-- 价目表 + 定价规则(阶梯)
-- 定价引擎 pricing_pkg 的取价优先级: 客户专属表 > 默认表，同表内 priority 小者先命中
-- 规则可按 物料 / 分类 / 客户 任意组合限定，min_qty/max_qty 划分数量阶梯
-- 与 bank 的 fee_rate 同思路，但叠了多维匹配 + 折扣类型，命中逻辑更绕

CREATE TABLE t_price_list (
    price_list_id   NUMBER(18)     NOT NULL,
    list_code       VARCHAR2(32)   NOT NULL,
    list_name       VARCHAR2(100)  NOT NULL,
    currency_code   VARCHAR2(8)    DEFAULT 'CNY' NOT NULL,
    is_default      CHAR(1)        DEFAULT 'N' NOT NULL,
    valid_from      DATE           DEFAULT SYSDATE NOT NULL,
    valid_to        DATE,
    is_active       CHAR(1)        DEFAULT 'Y' NOT NULL,
    CONSTRAINT pk_price_list PRIMARY KEY (price_list_id),
    CONSTRAINT uk_price_list_code UNIQUE (list_code),
    CONSTRAINT ck_pricelist_default CHECK (is_default IN ('Y','N')),
    CONSTRAINT ck_pricelist_active  CHECK (is_active IN ('Y','N'))
);


CREATE TABLE t_price_rule (
    rule_id         NUMBER(18)     NOT NULL,
    price_list_id   NUMBER(18)     NOT NULL,
    item_id         NUMBER(18),
    category_id     NUMBER(18),
    customer_id     NUMBER(18),
    min_qty         NUMBER(18,4)   DEFAULT 0 NOT NULL,
    max_qty         NUMBER(18,4),
    rule_type       VARCHAR2(16)   DEFAULT 'LIST' NOT NULL,
    price_value     NUMBER(20,6)   NOT NULL,
    priority        NUMBER(6)      DEFAULT 100 NOT NULL,
    valid_from      DATE           DEFAULT SYSDATE NOT NULL,
    valid_to        DATE,
    is_active       CHAR(1)        DEFAULT 'Y' NOT NULL,
    CONSTRAINT pk_price_rule PRIMARY KEY (rule_id),
    CONSTRAINT fk_pricerule_list     FOREIGN KEY (price_list_id) REFERENCES t_price_list(price_list_id),
    CONSTRAINT fk_pricerule_item     FOREIGN KEY (item_id)       REFERENCES t_item(item_id),
    CONSTRAINT fk_pricerule_category FOREIGN KEY (category_id)   REFERENCES t_item_category(category_id),
    CONSTRAINT fk_pricerule_customer FOREIGN KEY (customer_id)   REFERENCES t_customer(customer_id),
    CONSTRAINT ck_pricerule_type   CHECK (rule_type IN ('LIST','DISCOUNT_PCT','DISCOUNT_AMT','OVERRIDE')),
    CONSTRAINT ck_pricerule_active CHECK (is_active IN ('Y','N')),
    CONSTRAINT ck_pricerule_qty    CHECK (max_qty IS NULL OR max_qty > min_qty)
);

COMMENT ON COLUMN t_price_rule.rule_type IS 'LIST 标准价 / DISCOUNT_PCT 折扣率 / DISCOUNT_AMT 减额 / OVERRIDE 一口价';
COMMENT ON COLUMN t_price_rule.priority IS '命中优先级，越小越先；物料级一般小于分类级，确保细粒度优先';
