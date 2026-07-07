-- 非包 DDL：建表。放在 header/body 之外的 schema/ 子目录，
-- 仅当 sourcePath(父目录) 作为额外 root 被扫描时才能进 tables 索引。
CREATE TABLE accounts (
    account_id   NUMBER(10)    NOT NULL,
    balance      NUMBER(10,2)  DEFAULT 0 NOT NULL,
    status       VARCHAR2(10)  DEFAULT 'ACTIVE' NOT NULL,
    CONSTRAINT pk_accounts PRIMARY KEY (account_id)
);
