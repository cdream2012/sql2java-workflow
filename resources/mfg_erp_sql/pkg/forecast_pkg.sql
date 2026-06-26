-- 需求预测 + 动态透视
-- generate_forecast 用 MODEL 子句做滚动预测: 把历史按期排成"行=物料,列=期"的单元格
-- 用 rule 递推未来期 = 前 N 期移动平均 / 线性趋势，cv()/迭代体现电子表格式计算
-- pivot_demand_dynamic 列(期数)在编译期未知，走 DBMS_SQL 动态拼列再转 ref cursor 返回

CREATE OR REPLACE PACKAGE forecast_pkg AS

    -- 生成/刷新预测: MODEL 子句滚动外推，结果 merge 进 t_demand_forecast
    -- p_method: MA3/MA6 移动平均 或 TREND 线性趋势
    PROCEDURE generate_forecast(
        p_run_date      IN DATE     DEFAULT NULL,
        p_method        IN VARCHAR2 DEFAULT 'MA3',
        p_periods_ahead IN NUMBER   DEFAULT 3
    );

    -- 预测准确率: 对已有 actual 的期算 MAPE / 偏差，分析函数给滚动准确率
    PROCEDURE forecast_accuracy(
        p_item_id IN  NUMBER   DEFAULT NULL,
        p_cur     OUT SYS_REFCURSOR
    );

    -- 动态透视: 把需求按"物料 x 期"透视成宽表，列数随期数动态变化
    -- 编译期不知有多少列，用 DBMS_SQL 拼 select ... pivot(...) 后 dbms_sql.to_refcursor 返回
    PROCEDURE pivot_demand_dynamic(
        p_from_period IN  DATE,
        p_to_period   IN  DATE,
        p_cur         OUT SYS_REFCURSOR
    );

END forecast_pkg;
/

-- 需求预测 包体
-- generate_forecast 是本库 MODEL 子句的唯一落点: 把历史按 (物料, 期序号) 排成单元格,
--   partition by item_id, dimension by 期序号 n, measures(qty),用 rules 递推未来期
--   MA3/MA6 = 前 N 期移动平均(引用 cv()-1..cv()-N 的相对偏移),TREND = 末期 + 平均环比增量
-- pivot_demand_dynamic 是本库 DBMS_SQL 的唯一落点: 透视的列(期数)编译期未知,
--   先查出区间内有哪些 period 动态拼 select ... pivot(...),再 dbms_sql.to_refcursor 转出参

CREATE OR REPLACE PACKAGE BODY forecast_pkg AS

    -- 期序号: 把 period_date 折成"距锚点的月数",MODEL 用整数维度比日期维度好递推
    -- 锚点统一取 2000-01,任意月度首日 -> 唯一整数,且单调(SQL 里同款算式直接内联,见 MODEL)
    FUNCTION period_seq(p_period IN DATE) RETURN NUMBER IS
    BEGIN
        RETURN MONTHS_BETWEEN(TRUNC(p_period, 'MM'), DATE '2000-01-01');
    END period_seq;


    PROCEDURE generate_forecast(
        p_run_date      IN DATE     DEFAULT NULL,
        p_method        IN VARCHAR2 DEFAULT 'MA3',
        p_periods_ahead IN NUMBER   DEFAULT 3
    ) IS
        v_run_date DATE := NVL(p_run_date, util_pkg.curr_biz_date());
        v_method   VARCHAR2(16) := UPPER(NVL(p_method, 'MA3'));
        v_ahead    PLS_INTEGER := NVL(p_periods_ahead, 3);
        v_anchor   NUMBER := period_seq(v_run_date);  -- 最后一个有实绩的期序号(含当期)
        v_window   PLS_INTEGER := CASE WHEN v_method = 'MA6' THEN 6 ELSE 3 END;
        v_run_id   NUMBER := seq_forecast_id.NEXTVAL;
        v_merged   NUMBER := 0;
    BEGIN
        IF v_method NOT IN ('MA3','MA6','TREND') THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_system, const_pkg.c_mod_forecast, 'generate_forecast',
                '不支持的预测方法: ' || v_method, v_method);
        END IF;

        -- MODEL 子句滚动外推
        -- 思路: (item_id, warehouse_id) 一个 partition,维度 n=月序号(距 2000-01 的月数),
        --   measure qty 装历史实绩(无 actual 退 forecast_qty),未来期由 rules 递推
        -- rules iterate(v_ahead): 迭代号 0..v_ahead-1 各算一个未来期,目标 n=v_anchor+iter+1
        --   cv() 引用相对偏移取前 N 期(可能含上一轮刚外推出的未来期),实现链式滚动
        -- MA3/MA6 = 前 v_window 期算术平均;TREND = 末期 + 平均环比增量((末期-window期前)/window)
        -- 月序号用 months_between/add_months 直接在 SQL 里算,不引用包内私有函数(SQL 不可见)
        MERGE INTO t_demand_forecast tgt
        USING (
            SELECT item_id,
                   warehouse_id,
                   ADD_MONTHS(DATE '2000-01-01', n) AS period_date,
                   ROUND(qty, 4)                    AS forecast_qty
              FROM (
                    -- 基础单元格: 历史实绩按 (item, warehouse, 月序号) 聚合
                    SELECT f.item_id,
                           f.warehouse_id,
                           MONTHS_BETWEEN(TRUNC(f.period_date, 'MM'), DATE '2000-01-01') AS n,
                           SUM(NVL(f.actual_qty, f.forecast_qty))                        AS qty
                      FROM t_demand_forecast f
                     WHERE f.period_date < ADD_MONTHS(DATE '2000-01-01', v_anchor + 1)
                     GROUP BY f.item_id, f.warehouse_id,
                              MONTHS_BETWEEN(TRUNC(f.period_date, 'MM'), DATE '2000-01-01')
                     MODEL
                       PARTITION BY (item_id, warehouse_id)
                       DIMENSION BY (n)
                       MEASURES (qty)
                       RULES UPSERT ALL ITERATE (1000) UNTIL (ITERATION_NUMBER + 1 >= v_ahead)
                       (
                           -- 目标期 = v_anchor + 当前迭代号 + 1
                           qty[v_anchor + ITERATION_NUMBER + 1] =
                               CASE
                                   WHEN v_method = 'TREND' THEN
                                       GREATEST(
                                         NVL(qty[v_anchor + ITERATION_NUMBER], 0)
                                           + (NVL(qty[v_anchor + ITERATION_NUMBER], 0)
                                              - NVL(qty[v_anchor + ITERATION_NUMBER - v_window], 0)) / v_window,
                                         0)
                                   ELSE
                                       -- 移动平均: 前 v_window 期(含已外推的未来期)算术平均
                                       GREATEST(
                                         ( NVL(qty[v_anchor + ITERATION_NUMBER],     0)
                                         + NVL(qty[v_anchor + ITERATION_NUMBER - 1], 0)
                                         + NVL(qty[v_anchor + ITERATION_NUMBER - 2], 0)
                                         + CASE WHEN v_window >= 6 THEN
                                               NVL(qty[v_anchor + ITERATION_NUMBER - 3], 0)
                                             + NVL(qty[v_anchor + ITERATION_NUMBER - 4], 0)
                                             + NVL(qty[v_anchor + ITERATION_NUMBER - 5], 0)
                                           ELSE 0 END
                                         ) / v_window,
                                         0)
                               END
                       )
                   )
             -- 只取算出来的未来期回写,历史期不动
             WHERE n > v_anchor
        ) src
        ON (    tgt.item_id      = src.item_id
            AND NVL(tgt.warehouse_id, -1) = NVL(src.warehouse_id, -1)
            AND tgt.period_date  = src.period_date
            AND tgt.method       = v_method)
        WHEN MATCHED THEN UPDATE SET
            tgt.forecast_qty = src.forecast_qty,
            tgt.run_id       = v_run_id
        WHEN NOT MATCHED THEN INSERT (
            forecast_id, item_id, warehouse_id, period_date,
            forecast_qty, method, run_id, created_at
        ) VALUES (
            seq_forecast_id.NEXTVAL, src.item_id, src.warehouse_id, src.period_date,
            src.forecast_qty, v_method, v_run_id, CURRENT_TIMESTAMP
        );

        v_merged := sql%ROWCOUNT;

        exc_pkg.log_error(
            p_error_code  => 'I6010',
            p_module      => const_pkg.c_mod_forecast,
            p_procedure   => 'generate_forecast',
            p_error_msg   => '预测生成 method=' || v_method || ' ahead=' || v_ahead
                          || ' anchor=' || TO_CHAR(v_run_date, 'YYYY-MM') || ' rows=' || v_merged,
            p_biz_key     => TO_CHAR(v_run_id),
            p_error_level => 'INFO');
    EXCEPTION
        WHEN OTHERS THEN
            exc_pkg.log_error(
                p_error_code => const_pkg.c_err_system,
                p_module     => const_pkg.c_mod_forecast,
                p_procedure  => 'generate_forecast',
                p_error_msg  => '预测生成失败 method=' || v_method || ': ' || SQLERRM,
                p_biz_key    => TO_CHAR(v_run_id));
            RAISE;
    END generate_forecast;


    PROCEDURE forecast_accuracy(
        p_item_id IN  NUMBER   DEFAULT NULL,
        p_cur     OUT SYS_REFCURSOR
    ) IS
    BEGIN
        -- 只对既有预测又有实绩的期算准确率: 绝对百分比误差 MAPE = |actual-forecast|/actual
        -- 偏差 bias = forecast-actual(正=高估);滚动准确率用 3 期移动平均的 (1-MAPE)
        -- 分析函数 avg over rows 给每个物料的滚动窗口,体现"近期预测准不准"的趋势
        -- lag/lead 取上一期/下一期实绩,算需求环比(mom_growth),给"预测该不该跟着趋势走"做参照
        OPEN p_cur FOR
            SELECT item_id,
                   period_date,
                   method,
                   forecast_qty,
                   actual_qty,
                   abs_pct_err,
                   bias,
                   LAG(actual_qty) OVER (
                             PARTITION BY item_id ORDER BY period_date)  AS prev_actual,
                   LEAD(actual_qty) OVER (
                             PARTITION BY item_id ORDER BY period_date)  AS next_actual,
                   ROUND((actual_qty - LAG(actual_qty) OVER (
                               PARTITION BY item_id ORDER BY period_date))
                         / NULLIF(LAG(actual_qty) OVER (
                               PARTITION BY item_id ORDER BY period_date), 0), 4) AS mom_growth,
                   ROUND(AVG(abs_pct_err) OVER (
                             PARTITION BY item_id
                             ORDER BY period_date
                             ROWS BETWEEN 2 PRECEDING AND CURRENT ROW), 4) AS mape_3m,
                   ROUND(1 - AVG(abs_pct_err) OVER (
                             PARTITION BY item_id
                             ORDER BY period_date
                             ROWS BETWEEN 2 PRECEDING AND CURRENT ROW), 4) AS rolling_accuracy
              FROM (
                    SELECT f.item_id,
                           f.period_date,
                           f.method,
                           f.forecast_qty,
                           f.actual_qty,
                           ROUND(ABS(f.actual_qty - f.forecast_qty)
                                 / NULLIF(f.actual_qty, 0), 4) AS abs_pct_err,
                           ROUND(f.forecast_qty - f.actual_qty, 4) AS bias
                      FROM t_demand_forecast f
                     WHERE f.actual_qty IS NOT NULL
                       AND f.method <> 'MANUAL'
                       AND (p_item_id IS NULL OR f.item_id = p_item_id)
                   )
             ORDER BY item_id, period_date;
    END forecast_accuracy;


    PROCEDURE pivot_demand_dynamic(
        p_from_period IN  DATE,
        p_to_period   IN  DATE,
        p_cur         OUT SYS_REFCURSOR
    ) IS
        v_cur_id   INTEGER;
        v_sql      CLOB;
        v_cols     CLOB;
        v_dummy    INTEGER;
        v_from     DATE := TRUNC(p_from_period, 'MM');
        v_to       DATE := TRUNC(p_to_period, 'MM');
    BEGIN
        -- 透视列 = 区间内出现过的各月,编译期未知,先查出来拼成 pivot 的 in 列表
        -- 每月一列,列名形如 "M_202601",值为该物料该月的需求量(取实绩否则预测)
        FOR r IN (
            SELECT DISTINCT TRUNC(period_date, 'MM') AS pm
              FROM t_demand_forecast
             WHERE period_date BETWEEN v_from AND v_to
             ORDER BY 1
        ) LOOP
            v_cols := v_cols
                || CASE WHEN v_cols IS NULL THEN '' ELSE ', ' END
                || '''' || TO_CHAR(r.pm, 'YYYY-MM-DD') || ''' as "M_'
                || TO_CHAR(r.pm, 'YYYYMM') || '"';
        END LOOP;

        -- 区间内没有任何数据: 拼一个空 in 列表会语法错,退化成只返回 item_id 的空透视
        IF v_cols IS NULL THEN
            v_cols := '''__none__'' as "M_NONE"';
        END IF;

        v_sql := 'select * from ('
              || '  select item_id,'
              || '         to_char(trunc(period_date, ''MM''), ''YYYY-MM-DD'') as pm,'
              || '         nvl(actual_qty, forecast_qty) as qty'
              || '    from t_demand_forecast'
              || '   where period_date between :b_from and :b_to'
              || ') pivot ( sum(qty) for pm in (' || v_cols || ') )'
              || ' order by item_id';

        -- 真用 DBMS_SQL: parse 动态串 -> 绑定区间 -> to_refcursor 转成 sys_refcursor 出参
        -- to_refcursor 会接管游标句柄,转换后不能再对 v_cur_id 做 dbms_sql 操作
        v_cur_id := DBMS_SQL.OPEN_CURSOR;
        DBMS_SQL.PARSE(v_cur_id, v_sql, DBMS_SQL.NATIVE);
        DBMS_SQL.BIND_VARIABLE(v_cur_id, ':b_from', v_from);
        DBMS_SQL.BIND_VARIABLE(v_cur_id, ':b_to',   v_to);
        v_dummy := DBMS_SQL.EXECUTE(v_cur_id);
        p_cur := DBMS_SQL.TO_REFCURSOR(v_cur_id);
    EXCEPTION
        WHEN OTHERS THEN
            IF DBMS_SQL.IS_OPEN(v_cur_id) THEN
                DBMS_SQL.CLOSE_CURSOR(v_cur_id);
            END IF;
            exc_pkg.log_error(
                p_error_code => const_pkg.c_err_system,
                p_module     => const_pkg.c_mod_forecast,
                p_procedure  => 'pivot_demand_dynamic',
                p_error_msg  => '动态透视失败: ' || SQLERRM,
                p_biz_key    => TO_CHAR(v_from, 'YYYY-MM') || '..' || TO_CHAR(v_to, 'YYYY-MM'));
            RAISE;
    END pivot_demand_dynamic;

END forecast_pkg;
/
