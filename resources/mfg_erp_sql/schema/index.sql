-- 二级索引
-- 只建被高频查询/外键关联且非主键覆盖的列；主键/唯一键自带索引不重复建
-- 分区表 t_inventory_txn 上建本地索引(local)，随分区滚动

CREATE INDEX idx_item_category   ON t_item(category_id);
CREATE INDEX idx_item_type       ON t_item(item_type, status);
CREATE INDEX idx_item_supplier   ON t_item(preferred_supplier);

CREATE INDEX idx_category_parent ON t_item_category(parent_category_id);

CREATE INDEX idx_bomhdr_item     ON t_bom_header(item_id, status);
CREATE INDEX idx_bomline_comp    ON t_bom_line(component_item_id);

CREATE INDEX idx_lot_item_wh     ON t_inventory_lot(item_id, warehouse_id, status);
CREATE INDEX idx_lot_fifo        ON t_inventory_lot(item_id, warehouse_id, receipt_date, lot_id);

CREATE INDEX idx_invtxn_item     ON t_inventory_txn(item_id, warehouse_id, txn_date) LOCAL;
CREATE INDEX idx_invtxn_ref      ON t_inventory_txn(ref_doc_type, ref_doc_id) LOCAL;

CREATE INDEX idx_poline_item     ON t_po_line(item_id, line_status);
CREATE INDEX idx_soline_item     ON t_so_line(item_id, line_status);

CREATE INDEX idx_prod_item       ON t_production_order(item_id, status);
CREATE INDEX idx_mrpplan_run     ON t_mrp_plan(run_id, item_id, bucket_date);

CREATE INDEX idx_pricerule_match ON t_price_rule(price_list_id, item_id, category_id, is_active);

CREATE INDEX idx_forecast_item   ON t_demand_forecast(item_id, period_date);

CREATE INDEX idx_errlog_occurred ON t_error_log(occurred_at);
CREATE INDEX idx_auditlog_key    ON t_audit_log(table_name, biz_key);
