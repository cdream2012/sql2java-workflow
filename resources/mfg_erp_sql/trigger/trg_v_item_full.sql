-- 物料宽视图的 INSTEAD OF 触发器
-- v_item_full 是多表 join + 对象列拍平的视图，本身不可直接 DML
-- 前台维护界面对视图增改时，由本触发器拆解平铺字段、委托 item_pkg 拼回对象列写主表
-- 分类名/单位名等 join 出来的列只读，界面传了也忽略

CREATE OR REPLACE TRIGGER trg_v_item_full
INSTEAD OF INSERT OR UPDATE ON v_item_full
FOR EACH ROW
BEGIN
    IF INSERTING THEN
        DECLARE
            v_item_id NUMBER;
        BEGIN
            item_pkg.create_item(
                p_item_code   => :NEW.item_code,
                p_item_name   => :NEW.item_name,
                p_item_type   => :NEW.item_type,
                p_category_id => :NEW.category_id,
                p_base_uom    => :NEW.base_uom,
                p_std_cost    => :NEW.std_cost,
                p_dim         => t_dimension(:NEW.length_cm, :NEW.width_cm,
                                             :NEW.height_cm, :NEW.weight_kg),
                p_item_id     => v_item_id);
        END;
    ELSE
        item_pkg.apply_item_flat(
            p_item_id    => :OLD.item_id,
            p_item_name  => :NEW.item_name,
            p_std_cost   => :NEW.std_cost,
            p_list_price => :NEW.list_price,
            p_status     => :NEW.status,
            p_length_cm  => :NEW.length_cm,
            p_width_cm   => :NEW.width_cm,
            p_height_cm  => :NEW.height_cm,
            p_weight_kg  => :NEW.weight_kg);
    END IF;
END;
/
