-- 系统控制表: 业务日期、运行参数、错误日志、审计日志
-- 业务日期与 bank_core_sql 同构: 日终(日切)推进 curr_biz_date，期间闸门防并发跑批

CREATE TABLE t_business_date (
    sys_code        VARCHAR2(16)   NOT NULL,
    curr_biz_date   DATE           NOT NULL,
    last_biz_date   DATE,
    next_biz_date   DATE,
    period_status   VARCHAR2(16)   DEFAULT 'OPEN' NOT NULL,
    updated_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_business_date PRIMARY KEY (sys_code),
    CONSTRAINT ck_bizdate_status CHECK (period_status IN ('OPEN','RUNNING','CLOSED'))
);

COMMENT ON COLUMN t_business_date.period_status IS 'OPEN 可交易 / RUNNING 跑批占用 / CLOSED 日切中';


-- 运行参数，键值对，应用层与包内 util 都读
-- param_type 决定取值时如何转型，sql2java 需注意 value 列是 varchar 但语义可能是数字/布尔
CREATE TABLE t_app_param (
    param_key     VARCHAR2(64)   NOT NULL,
    param_value   VARCHAR2(500),
    param_type    VARCHAR2(16)   DEFAULT 'STRING' NOT NULL,
    description   VARCHAR2(200),
    updated_by    VARCHAR2(32),
    updated_at    TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_app_param PRIMARY KEY (param_key),
    CONSTRAINT ck_param_type CHECK (param_type IN ('STRING','NUMBER','BOOL','DATE','JSON'))
);


-- 错误日志，exc_pkg.log_error 自治事务写入，主事务回滚不影响
CREATE TABLE t_error_log (
    log_id          NUMBER(18)     NOT NULL,
    error_code      VARCHAR2(16)   NOT NULL,
    error_level     VARCHAR2(8)    DEFAULT 'ERROR' NOT NULL,
    module_name     VARCHAR2(64),
    procedure_name  VARCHAR2(64),
    error_msg       VARCHAR2(2000),
    error_stack     VARCHAR2(4000),
    biz_key         VARCHAR2(100),
    context_data    CLOB,
    operator        VARCHAR2(32),
    occurred_at     TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_error_log PRIMARY KEY (log_id),
    CONSTRAINT ck_error_level CHECK (error_level IN ('INFO','WARN','ERROR','FATAL'))
);


-- 审计日志，old/new 用 JSON 串，由触发器与业务包共同写入
CREATE TABLE t_audit_log (
    audit_id      NUMBER(18)     NOT NULL,
    table_name    VARCHAR2(64)   NOT NULL,
    action_type   VARCHAR2(16)   NOT NULL,
    biz_key       VARCHAR2(100),
    old_value     CLOB,
    new_value     CLOB,
    operator      VARCHAR2(32),
    operated_at   TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_audit_log PRIMARY KEY (audit_id)
);
