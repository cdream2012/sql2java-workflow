-- 需求预测 + 动态透视
-- generate_forecast 用 MODEL 子句做滚动预测: 把历史按期排成"行=物料,列=期"的单元格
-- 用 rule 递推未来期 = 前 N 期移动平均 / 线性趋势，cv()/迭代体现电子表格式计算
-- pivot_demand_dynamic 列(期数)在编译期未知，走 DBMS_SQL 动态拼列再转 ref cursor 返回

CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE MFG_ERP.F_FORECAST IS
    -- Author : sql2java-workflow
    -- Created : 2026-07-03
    -- Purpose : 需求预测 + 动态透视 / generate_forecast 用 MODEL 子句做滚动预测: 把历史按期排成"行=物料,列=期"的单元格 / 用 rule 递推未来期 = 前 N 期移动平均 / 线性趋势，cv()/迭代体现电子表格式计算 / pivot_demand_dynamic 列(期数)在编译期未知，走 DBMS_SQL 动态拼列再转 ref cursor 返回

    -- 生成/刷新预测: MODEL 子句滚动外推，结果 merge 进 t_demand_forecast
    -- p_method: MA3/MA6 移动平均 或 TREND 线性趋势
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：生成/刷新预测: MODEL 子句滚动外推，结果 merge 进 t_demand_forecast / p_method: MA3/MA6 移动平均 或 TREND 线性趋势
    *****************************************************************/
    PROCEDURE generate_forecast(
        id_run_date      IN DATE     DEFAULT NULL,
        is_method        IN VARCHAR2 DEFAULT 'MA3',
        ii_periods_ahead IN NUMBER   DEFAULT 3
    );

    -- 预测准确率: 对已有 actual 的期算 MAPE / 偏差，分析函数给滚动准确率
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：预测准确率: 对已有 actual 的期算 MAPE / 偏差，分析函数给滚动准确率
    *****************************************************************/
    PROCEDURE forecast_accuracy(
        ii_item_id IN  NUMBER   DEFAULT NULL,
        or_cur     OUT SYS_REFCURSOR
    );

    -- 动态透视: 把需求按"物料 x 期"透视成宽表，列数随期数动态变化
    -- 编译期不知有多少列，用 DBMS_SQL 拼 select ... pivot(...) 后 dbms_sql.to_refcursor 返回
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：动态透视: 把需求按"物料 x 期"透视成宽表，列数随期数动态变化 / 编译期不知有多少列，用 DBMS_SQL 拼 select ... pivot(...) 后 dbms_sql.to_refcursor 返回
    *****************************************************************/
    PROCEDURE pivot_demand_dynamic(
        id_from_period IN  DATE,
        id_to_period   IN  DATE,
        or_cur         OUT SYS_REFCURSOR
    );

END f_forecast;

-- 需求预测 包体
-- generate_forecast 是本库 MODEL 子句的唯一落点: 把历史按 (物料, 期序号) 排成单元格,
--   partition by item_id, dimension by 期序号 n, measures(qty),用 rules 递推未来期
--   MA3/MA6 = 前 N 期移动平均(引用 cv()-1..cv()-N 的相对偏移),TREND = 末期 + 平均环比增量
-- pivot_demand_dynamic 是本库 DBMS_SQL 的唯一落点: 透视的列(期数)编译期未知,
--   先查出区间内有哪些 period 动态拼 select ... pivot(...),再 dbms_sql.to_refcursor 转出参
