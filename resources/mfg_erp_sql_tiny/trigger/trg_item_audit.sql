-- 行级触发器 + WHEN 子句
CREATE OR REPLACE TRIGGER trg_item_audit
AFTER UPDATE OF std_cost, status ON t_item
FOR EACH ROW
WHEN (OLD.std_cost <> NEW.std_cost)
BEGIN
  INSERT INTO t_error_log(log_id, error_code, error_msg, operator, occurred_at)
  VALUES(seq_error_log_id.NEXTVAL, 'AUDIT',
    '{"old":'||:OLD.std_cost||',"new":'||:NEW.std_cost||'}',
    USER, CURRENT_TIMESTAMP);
END;
/
