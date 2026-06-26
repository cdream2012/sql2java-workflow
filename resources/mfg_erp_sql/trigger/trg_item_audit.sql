-- 物料关键字段变更审计
-- 只在 状态/标准成本/售价 实际变化时记录，改个名字、改尺寸不进审计，减噪音
-- when 子句在行级过滤掉"值没变"的伪更新(update 全列时这三列可能被原值覆盖)

CREATE OR REPLACE TRIGGER trg_item_audit
AFTER UPDATE OF status, std_cost, list_price ON t_item
FOR EACH ROW
WHEN (OLD.status   <> NEW.status
   OR OLD.std_cost <> NEW.std_cost
   OR OLD.list_price <> NEW.list_price)
BEGIN
    INSERT INTO t_audit_log(
        audit_id, table_name, action_type, biz_key,
        old_value, new_value, operator, operated_at
    ) VALUES (
        seq_audit_log_id.NEXTVAL,
        't_item',
        'UPDATE',
        :NEW.item_code,
        '{"status":"' || :OLD.status || '","std_cost":' || :OLD.std_cost
            || ',"list_price":' || :OLD.list_price || '}',
        '{"status":"' || :NEW.status || '","std_cost":' || :NEW.std_cost
            || ',"list_price":' || :NEW.list_price || '}',
        NVL(SYS_CONTEXT('userenv','session_user'), 'SYSTEM'),
        CURRENT_TIMESTAMP
    );
END;
/
