-- 制造/供应链 ERP - 完整部署入口 (格式化版: 关键字大写 / 包 spec+body 合并)
-- 数据库: GaussDB (Oracle 兼容模式 / sql_compatibility = 'A')，对象类型/MODEL/DBMS_SQL/复合触发器均按 Oracle 语义
-- 用法:   gsql -d <db> -U <user> -W <pwd> -f install.sql
-- 重新部署前需 drop 全部对象；本脚本不含 drop，避免误删
--
-- 部署顺序依赖:
--   对象类型先于 schema(t_item 有 t_dimension/t_tag_varray 对象列、v_item_full 调对象方法)
--   schema 内按 FK: dict -> sysctl -> warehouse -> partner -> item(含分类) -> bom
--                  -> inventory -> orders -> production -> pricing -> forecast -> view
--   seq/index 在表之后，seed 在其后(用到序列)，且 seed 先于 trigger(否则种子触发大量审计)
--   包: const/exc/util 在前，业务包按依赖顺序(const->exc->util->item->bom->inventory->costing
--       ->pricing->procurement->mrp->forecast->report->sched)加载，每包单文件含 spec+body
--   独立函数(SQL 直调)放包之后，触发器放最后(trg_v_item_full 依赖 item_pkg)


-- 对象类型
@@type/obj_money.sql
@@type/obj_dimension.sql
@@type/coll_tags.sql
@@type/obj_item.sql
@@type/obj_bom_comp.sql
@@type/obj_allocation.sql
@@type/obj_explosion.sql

-- schema: 表(按 FK 依赖)
@@schema/dict.sql
@@schema/sysctl.sql
@@schema/warehouse.sql
@@schema/partner.sql
@@schema/item.sql
@@schema/bom.sql
@@schema/inventory.sql
@@schema/orders.sql
@@schema/production.sql
@@schema/pricing.sql
@@schema/forecast.sql
@@schema/view.sql

-- 序列 / 索引 / 种子
@@schema/sequence.sql
@@schema/index.sql
@@schema/seed.sql

-- 基础包 + 业务包(spec+body 合并单文件，按依赖顺序)
@@pkg/const_pkg.sql
@@pkg/exc_pkg.sql
@@pkg/util_pkg.sql
@@pkg/item_pkg.sql
@@pkg/bom_pkg.sql
@@pkg/inventory_pkg.sql
@@pkg/costing_pkg.sql
@@pkg/pricing_pkg.sql
@@pkg/procurement_pkg.sql
@@pkg/mrp_pkg.sql
@@pkg/forecast_pkg.sql
@@pkg/report_pkg.sql
@@pkg/sched_pkg.sql

-- 独立函数(SQL 直接调用，递归卷算函数也在此)
@@func/fn_uom_convert.sql
@@func/fn_abc_class.sql
@@func/fn_landed_cost.sql
@@func/fn_bom_unit_cost.sql

-- 触发器: 放最后，避免种子装载时大量触发；trg_v_item_full 依赖 item_pkg 已就位
@@trigger/trg_inv_txn.sql
@@trigger/trg_item_audit.sql
@@trigger/trg_v_item_full.sql


PROMPT
PROMPT === Deployment check ===
SELECT 'tables'     AS item, COUNT(*) AS cnt FROM user_tables    WHERE table_name LIKE 'T_%'
UNION ALL SELECT 'object_types', COUNT(*) FROM user_types     WHERE type_name LIKE 'T_%'
UNION ALL SELECT 'sequences',    COUNT(*) FROM user_sequences  WHERE sequence_name LIKE 'SEQ_%'
UNION ALL SELECT 'packages',     COUNT(*) FROM user_objects    WHERE object_type = 'PACKAGE'
UNION ALL SELECT 'pkg_bodies',   COUNT(*) FROM user_objects    WHERE object_type = 'PACKAGE BODY'
UNION ALL SELECT 'functions',    COUNT(*) FROM user_objects    WHERE object_type = 'FUNCTION' AND object_name LIKE 'FN_%'
UNION ALL SELECT 'triggers',     COUNT(*) FROM user_objects    WHERE object_type = 'TRIGGER'
UNION ALL SELECT 'views',        COUNT(*) FROM user_views      WHERE view_name LIKE 'V_%'
UNION ALL SELECT 'invalid_obj',  COUNT(*) FROM user_objects    WHERE status = 'INVALID';
