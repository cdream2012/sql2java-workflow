-- 调度作业封装: 把跑批入口注册成 DBMS_SCHEDULER 作业
-- 真实生产由 ops 的调度平台拉起，这里用 DBMS_SCHEDULER 演示库内自调度
-- sql2java 侧一般映射成 @Scheduled / Quartz / XXL-JOB，本包是这类映射的样本

CREATE OR REPLACE PACKAGE sched_pkg AS

    -- 注册每日 MRP 作业: 每天 02:00 调 mrp_pkg.run_mrp
    PROCEDURE schedule_nightly_mrp;

    -- 注册每月预测刷新作业: 每月 1 号 01:00 调 forecast_pkg.generate_forecast
    PROCEDURE schedule_monthly_forecast;

    -- 立即跑一次指定作业(排障/补跑)
    PROCEDURE run_job_now(p_job_name IN VARCHAR2);

    -- 删除作业
    PROCEDURE drop_job(p_job_name IN VARCHAR2);

    -- 列出本应用注册的作业及上次运行结果
    PROCEDURE list_jobs(p_cur OUT SYS_REFCURSOR);

END sched_pkg;
/

-- sched_pkg 包体: 把跑批入口注册成 DBMS_SCHEDULER 作业
-- 作业名集中前缀 MFG_ 便于 list_jobs 按 like 过滤本应用作业，不误删别人的
-- run_mrp 带 out 参数不能直接做 stored_procedure 类型，统一用 plsql_block 包一层局部变量接 out
-- 真实生产调度多在 ops 平台，sql2java 侧一般落 @Scheduled / Quartz / XXL-JOB，这里是库内自调度样本

CREATE OR REPLACE PACKAGE BODY sched_pkg AS

    c_job_prefix      CONSTANT VARCHAR2(8)  := 'MFG_';
    c_job_nightly_mrp CONSTANT VARCHAR2(32) := 'MFG_NIGHTLY_MRP';
    c_job_monthly_fc  CONSTANT VARCHAR2(32) := 'MFG_MONTHLY_FORECAST';


    -- 私有: 重建作业前先吞掉同名旧作业，保证 schedule_* 可重复执行(幂等)
    PROCEDURE drop_if_exists(p_job_name IN VARCHAR2) IS
    BEGIN
        DBMS_SCHEDULER.DROP_JOB(job_name => p_job_name, force => TRUE);
    EXCEPTION
        WHEN OTHERS THEN
            -- -27475 作业不存在 / -27476 对象不存在，幂等场景下忽略，其余照抛
            IF SQLCODE IN (-27475, -27476) THEN
                NULL;
            ELSE
                RAISE;
            END IF;
    END drop_if_exists;


    PROCEDURE schedule_nightly_mrp IS
    BEGIN
        drop_if_exists(c_job_nightly_mrp);

        -- 每天 02:00 跑 MRP。run_mrp 的 p_run_id 是 out，匿名块里用局部变量接住即可
        DBMS_SCHEDULER.CREATE_JOB(
            job_name        => c_job_nightly_mrp,
            job_type        => 'PLSQL_BLOCK',
            job_action      => 'declare v_run_id number; begin mrp_pkg.run_mrp(p_run_id => v_run_id); end;',
            start_date      => TRUNC(SYSDATE) + 1 + 2 / 24,
            repeat_interval => 'FREQ=DAILY;BYHOUR=2',
            enabled         => TRUE,
            auto_drop       => FALSE,
            comments        => '每日 02:00 物料需求计划 MRP 跑批');

        exc_pkg.log_error(
            p_error_code  => 'I9001',
            p_module      => const_pkg.c_mod_sched,
            p_procedure   => 'schedule_nightly_mrp',
            p_error_msg   => '已注册作业 ' || c_job_nightly_mrp || ' FREQ=DAILY;BYHOUR=2',
            p_biz_key     => c_job_nightly_mrp,
            p_error_level => 'INFO');
    END schedule_nightly_mrp;


    PROCEDURE schedule_monthly_forecast IS
    BEGIN
        drop_if_exists(c_job_monthly_fc);

        -- 每月 1 号 01:00 刷预测，赶在当晚 MRP 之前。generate_forecast 全是带默认值的 in 参数
        DBMS_SCHEDULER.CREATE_JOB(
            job_name        => c_job_monthly_fc,
            job_type        => 'PLSQL_BLOCK',
            job_action      => 'begin forecast_pkg.generate_forecast; end;',
            start_date      => TRUNC(SYSDATE, 'MM') + 1 / 24,
            repeat_interval => 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=1',
            enabled         => TRUE,
            auto_drop       => FALSE,
            comments        => '每月 1 号 01:00 需求预测刷新');

        exc_pkg.log_error(
            p_error_code  => 'I9002',
            p_module      => const_pkg.c_mod_sched,
            p_procedure   => 'schedule_monthly_forecast',
            p_error_msg   => '已注册作业 ' || c_job_monthly_fc || ' FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=1',
            p_biz_key     => c_job_monthly_fc,
            p_error_level => 'INFO');
    END schedule_monthly_forecast;


    PROCEDURE run_job_now(p_job_name IN VARCHAR2) IS
    BEGIN
        -- use_current_session=>false 走调度器后台跑，不卡当前会话
        DBMS_SCHEDULER.RUN_JOB(job_name => p_job_name, use_current_session => FALSE);

        exc_pkg.log_error(
            p_error_code  => 'I9003',
            p_module      => const_pkg.c_mod_sched,
            p_procedure   => 'run_job_now',
            p_error_msg   => '手工触发作业 ' || p_job_name,
            p_biz_key     => p_job_name,
            p_error_level => 'INFO');
    EXCEPTION
        WHEN OTHERS THEN
            -- -27475 作业不存在时给业务错误，比裸 ORA 更可读
            IF SQLCODE = -27475 THEN
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_system, const_pkg.c_mod_sched, 'run_job_now',
                    '作业不存在 ' || p_job_name, p_job_name);
            ELSE
                RAISE;
            END IF;
    END run_job_now;


    PROCEDURE drop_job(p_job_name IN VARCHAR2) IS
    BEGIN
        -- force=>true: 即便作业正在运行也强制停掉再删
        DBMS_SCHEDULER.DROP_JOB(job_name => p_job_name, force => TRUE);

        exc_pkg.log_error(
            p_error_code  => 'I9004',
            p_module      => const_pkg.c_mod_sched,
            p_procedure   => 'drop_job',
            p_error_msg   => '删除作业 ' || p_job_name,
            p_biz_key     => p_job_name,
            p_error_level => 'INFO');
    EXCEPTION
        WHEN OTHERS THEN
            -- 作业本就不存在(已删/未建)按成功处理，调用方不必先判存在
            IF SQLCODE IN (-27475, -27476) THEN
                NULL;
            ELSE
                RAISE;
            END IF;
    END drop_job;


    PROCEDURE list_jobs(p_cur OUT SYS_REFCURSOR) IS
    BEGIN
        -- 只看本应用前缀的作业，左连最近一次运行明细取上次结果
        -- 同一作业 job_run_details 会有多条历史，用 row_number 取每作业最新一条
        OPEN p_cur FOR
            SELECT j.job_name,
                   j.enabled,
                   j.state,
                   j.repeat_interval,
                   j.last_start_date,
                   j.next_run_date,
                   j.run_count,
                   j.failure_count,
                   d.status      AS last_status,
                   d.error#      AS last_error_code,
                   d.actual_start_date AS last_run_start,
                   d.run_duration      AS last_run_duration
              FROM user_scheduler_jobs j
              LEFT JOIN (
                    SELECT log_id, job_name, status, error#,
                           actual_start_date, run_duration,
                           ROW_NUMBER() OVER (
                               PARTITION BY job_name
                               ORDER BY actual_start_date DESC) AS rn
                      FROM user_scheduler_job_run_details
                   ) d ON d.job_name = j.job_name AND d.rn = 1
             WHERE j.job_name LIKE c_job_prefix || '%'
             ORDER BY j.job_name;
    END list_jobs;

END sched_pkg;
/
