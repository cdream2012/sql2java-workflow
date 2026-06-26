-- 需求预测
-- 同一物料+仓库+时段一行，forecast_pkg 用 MODEL 子句做滚动预测(移动平均/趋势外推)
-- actual_qty 是事后回填的实际出货，与 forecast_qty 比对算预测准确率
-- period_date 统一取月度首日(每月 1 号)，时间桶按月

CREATE TABLE t_demand_forecast (
    forecast_id     NUMBER(18)     NOT NULL,
    item_id         NUMBER(18)     NOT NULL,
    warehouse_id    NUMBER(18),
    period_date     DATE           NOT NULL,
    forecast_qty    NUMBER(18,4)   DEFAULT 0 NOT NULL,
    actual_qty      NUMBER(18,4),
    method          VARCHAR2(16)   DEFAULT 'MA3' NOT NULL,
    run_id          NUMBER(18),
    created_at      TIMESTAMP      DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT pk_demand_forecast PRIMARY KEY (forecast_id),
    CONSTRAINT uk_forecast UNIQUE (item_id, warehouse_id, period_date, method),
    CONSTRAINT fk_forecast_item FOREIGN KEY (item_id)      REFERENCES t_item(item_id),
    CONSTRAINT fk_forecast_wh   FOREIGN KEY (warehouse_id) REFERENCES t_warehouse(warehouse_id),
    CONSTRAINT ck_forecast_method CHECK (method IN ('MA3','MA6','TREND','MANUAL'))
);

COMMENT ON COLUMN t_demand_forecast.method IS 'MA3/MA6 三/六期移动平均 / TREND 线性趋势 / MANUAL 人工录入';
