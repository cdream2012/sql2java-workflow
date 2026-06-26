-- 通用码表 + 计量单位 + 单位换算
-- 码表 t_code_dict 一表多类: dict_type 区分枚举域，避免每个枚举单开一张表
-- 物料类型/订单状态/库存事务类型等下拉值都落这里，应用层缓存，变更走配置发布

CREATE TABLE t_code_dict (
    dict_type    VARCHAR2(32)   NOT NULL,
    code         VARCHAR2(32)   NOT NULL,
    code_name    VARCHAR2(100)  NOT NULL,
    sort_no      NUMBER(6)      DEFAULT 0 NOT NULL,
    attr1        VARCHAR2(100),
    attr2        VARCHAR2(100),
    is_active    CHAR(1)        DEFAULT 'Y' NOT NULL,
    remark       VARCHAR2(200),
    CONSTRAINT pk_code_dict PRIMARY KEY (dict_type, code),
    CONSTRAINT ck_code_dict_active CHECK (is_active IN ('Y','N'))
);

COMMENT ON TABLE  t_code_dict IS '通用码表，dict_type 区分枚举域';
COMMENT ON COLUMN t_code_dict.attr1 IS '扩展属性，不同 dict_type 含义不同，如物料类型这里放默认估值方法';


-- 计量单位
-- uom_category 决定哪些单位之间可换算: 同类(都是重量)才允许，跨类(重量->长度)直接报错
CREATE TABLE t_uom (
    uom_code        VARCHAR2(8)    NOT NULL,
    uom_name        VARCHAR2(40)   NOT NULL,
    uom_category    VARCHAR2(8)    NOT NULL,
    decimal_digits  NUMBER(2)      DEFAULT 2 NOT NULL,
    is_base         CHAR(1)        DEFAULT 'N' NOT NULL,
    CONSTRAINT pk_uom PRIMARY KEY (uom_code),
    CONSTRAINT ck_uom_category CHECK (uom_category IN ('EA','WT','VOL','LEN','TIME')),
    CONSTRAINT ck_uom_base     CHECK (is_base IN ('Y','N'))
);

COMMENT ON TABLE  t_uom IS '计量单位';
COMMENT ON COLUMN t_uom.uom_category IS 'EA 计数 / WT 重量 / VOL 体积 / LEN 长度 / TIME 时间';
COMMENT ON COLUMN t_uom.is_base IS '每个 category 仅一个基本单位，换算以它为枢轴';


-- 单位换算系数，存到基本单位的折算率
-- 不存所有两两组合，只存 from -> 基本单位；任意两单位换算 = from->base / to->base
-- fn_uom_convert 据此计算，跨 category 抛异常
CREATE TABLE t_uom_conversion (
    from_uom    VARCHAR2(8)    NOT NULL,
    to_uom      VARCHAR2(8)    NOT NULL,
    factor      NUMBER(20,8)   NOT NULL,
    CONSTRAINT pk_uom_conversion PRIMARY KEY (from_uom, to_uom),
    CONSTRAINT fk_uomconv_from FOREIGN KEY (from_uom) REFERENCES t_uom(uom_code),
    CONSTRAINT fk_uomconv_to   FOREIGN KEY (to_uom)   REFERENCES t_uom(uom_code),
    CONSTRAINT ck_uomconv_factor CHECK (factor > 0)
);

COMMENT ON COLUMN t_uom_conversion.factor IS '1 个 from_uom = factor 个 to_uom';
