-- 库存流水复合触发器
-- 用复合触发器(compound)而非普通行触发器，是为了把"本次 DML 语句内所有流水行"
-- 按 物料+仓库 聚合后只写一条净变动审计，而不是每行各写一条(批量收发时行数可能上万)
-- 余额维护由 inventory_pkg 自己 merge，触发器刻意不碰 t_inventory_balance，避免双重记账
-- after each row 里累加到包级关联数组，after statement 再统一落审计——这也是规避变异表的经典写法

CREATE OR REPLACE TRIGGER trg_inv_txn
FOR INSERT ON t_inventory_txn
COMPOUND TRIGGER

    TYPE t_net_map IS TABLE OF NUMBER INDEX BY VARCHAR2(64);
    g_net      t_net_map;
    g_row_cnt  NUMBER;

    BEFORE STATEMENT IS
    BEGIN
        g_net.DELETE;
        g_row_cnt := 0;
    END BEFORE STATEMENT;

    AFTER EACH ROW IS
        v_key VARCHAR2(64);
        v_signed NUMBER;
    BEGIN
        v_key    := :NEW.item_id || '-' || :NEW.warehouse_id;
        v_signed := CASE :NEW.direction WHEN 'I' THEN :NEW.quantity ELSE -:NEW.quantity END;
        g_net(v_key) := NVL(g_net(v_key), 0) + v_signed;
        g_row_cnt    := g_row_cnt + 1;
    END AFTER EACH ROW;

    AFTER STATEMENT IS
        v_key VARCHAR2(64);
    BEGIN
        v_key := g_net.FIRST;
        WHILE v_key IS NOT NULL LOOP
            INSERT INTO t_audit_log(
                audit_id, table_name, action_type, biz_key,
                new_value, operator, operated_at
            ) VALUES (
                seq_audit_log_id.NEXTVAL, 't_inventory_txn', 'BATCH_NET', v_key,
                '{"net_qty":' || g_net(v_key) || ',"rows_in_stmt":' || g_row_cnt || '}',
                NVL(SYS_CONTEXT('userenv','session_user'), 'SYSTEM'), CURRENT_TIMESTAMP
            );
            v_key := g_net.NEXT(v_key);
        END LOOP;
    END AFTER STATEMENT;

END trg_inv_txn;
/
