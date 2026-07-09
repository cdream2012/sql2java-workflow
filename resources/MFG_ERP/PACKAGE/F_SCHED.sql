-- 调度作业封装: 把跑批入口注册成 DBMS_SCHEDULER 作业
-- 真实生产由 ops 的调度平台拉起，这里用 DBMS_SCHEDULER 演示库内自调度
-- sql2java 侧一般映射成 @Scheduled / Quartz / XXL-JOB，本包是这类映射的样本

CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE MFG_ERP.F_SCHED IS
    -- Author : sql2java-workflow
    -- Created : 2026-07-03
    -- Purpose : 调度作业封装: 把跑批入口注册成 DBMS_SCHEDULER 作业 / 真实生产由 ops 的调度平台拉起，这里用 DBMS_SCHEDULER 演示库内自调度 / sql2java 侧一般映射成 @Scheduled / Quartz / XXL-JOB，本包是这类映射的样本

    -- 注册每日 MRP 作业: 每天 02:00 调 MFG_ERP.F_MRP.run_mrp
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：注册每日 MRP 作业: 每天 02:00 调 MFG_ERP.F_MRP.run_mrp
    *****************************************************************/
    PROCEDURE schedule_nightly_mrp;

    -- 注册每月预测刷新作业: 每月 1 号 01:00 调 MFG_ERP.F_FORECAST.generate_forecast
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：注册每月预测刷新作业: 每月 1 号 01:00 调 MFG_ERP.F_FORECAST.generate_forecast
    *****************************************************************/
    PROCEDURE schedule_monthly_forecast;

    -- 立即跑一次指定作业(排障/补跑)
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：立即跑一次指定作业(排障/补跑)
    *****************************************************************/
    PROCEDURE run_job_now(is_job_name IN VARCHAR2);

    -- 删除作业
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：删除作业
    *****************************************************************/
    PROCEDURE drop_job(is_job_name IN VARCHAR2);

    -- 列出本应用注册的作业及上次运行结果
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：列出本应用注册的作业及上次运行结果
    *****************************************************************/
    PROCEDURE list_jobs(or_cur OUT SYS_REFCURSOR);

END f_sched;

-- F_SCHED 包体: 把跑批入口注册成 DBMS_SCHEDULER 作业
-- 作业名集中前缀 MFG_ 便于 list_jobs 按 like 过滤本应用作业，不误删别人的
-- run_mrp 带 out 参数不能直接做 stored_procedure 类型，统一用 plsql_block 包一层局部变量接 out
-- 真实生产调度多在 ops 平台，sql2java 侧一般落 @Scheduled / Quartz / XXL-JOB，这里是库内自调度样本
