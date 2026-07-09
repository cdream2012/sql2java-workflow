CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE BODY MFG_ERP.F_SCHED AS

    c_job_prefix      CONSTANT VARCHAR2(8)  := 'MFG_';
    c_job_nightly_mrp CONSTANT VARCHAR2(32) := 'MFG_NIGHTLY_MRP';
    c_job_monthly_fc  CONSTANT VARCHAR2(32) := 'MFG_MONTHLY_FORECAST';


    -- 私有: 重建作业前先吞掉同名旧作业，保证 schedule_* 可重复执行(幂等)
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：私有: 重建作业前先吞掉同名旧作业，保证 schedule_* 可重复执行(幂等)
    *****************************************************************/
    PROCEDURE drop_if_exists(is_job_name IN VARCHAR2) IS
    BEGIN
        DBMS_SCHEDULER.DROP_JOB(job_name => is_job_name, force => TRUE);
    EXCEPTION
        WHEN OTHERS THEN
            -- -27475 作业不存在 / -27476 对象不存在，幂等场景下忽略，其余照抛
            IF SQLCODE IN (-27475, -27476) THEN
                NULL;
            ELSE
                RAISE;
            END IF;
    END drop_if_exists;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：schedule_nightly_mrp
    *****************************************************************/
    PROCEDURE schedule_nightly_mrp IS
    BEGIN
        drop_if_exists(c_job_nightly_mrp);

        -- 每天 02:00 跑 MRP。run_mrp 的 p_run_id 是 out，匿名块里用局部变量接住即可
        DBMS_SCHEDULER.CREATE_JOB(
            job_name        => c_job_nightly_mrp,
            job_type        => 'PLSQL_BLOCK',
            job_action      => 'declare v_run_id number; begin MFG_ERP.F_MRP.run_mrp(oi_run_id => v_run_id); end;',
            start_date      => TRUNC(SYSDATE) + 1 + 2 / 24,
            repeat_interval => 'FREQ=DAILY;BYHOUR=2',
            enabled         => TRUE,
            auto_drop       => FALSE,
            comments        => '每日 02:00 物料需求计划 MRP 跑批');

        MFG_ERP.F_EXC.log_error(
            is_error_code  => 'I9001',
            is_module      => MFG_ERP.F_CONST.c_mod_sched,
            is_procedure   => 'schedule_nightly_mrp',
            is_error_msg   => '已注册作业 ' || c_job_nightly_mrp || ' FREQ=DAILY;BYHOUR=2',
            is_biz_key     => c_job_nightly_mrp,
            is_error_level => 'INFO');
    END schedule_nightly_mrp;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：schedule_monthly_forecast
    *****************************************************************/
    PROCEDURE schedule_monthly_forecast IS
    BEGIN
        drop_if_exists(c_job_monthly_fc);

        -- 每月 1 号 01:00 刷预测，赶在当晚 MRP 之前。generate_forecast 全是带默认值的 in 参数
        DBMS_SCHEDULER.CREATE_JOB(
            job_name        => c_job_monthly_fc,
            job_type        => 'PLSQL_BLOCK',
            job_action      => 'begin MFG_ERP.F_FORECAST.generate_forecast; end;',
            start_date      => TRUNC(SYSDATE, 'MM') + 1 / 24,
            repeat_interval => 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=1',
            enabled         => TRUE,
            auto_drop       => FALSE,
            comments        => '每月 1 号 01:00 需求预测刷新');

        MFG_ERP.F_EXC.log_error(
            is_error_code  => 'I9002',
            is_module      => MFG_ERP.F_CONST.c_mod_sched,
            is_procedure   => 'schedule_monthly_forecast',
            is_error_msg   => '已注册作业 ' || c_job_monthly_fc || ' FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=1',
            is_biz_key     => c_job_monthly_fc,
            is_error_level => 'INFO');
    END schedule_monthly_forecast;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：run_job_now
    *****************************************************************/
    PROCEDURE run_job_now(is_job_name IN VARCHAR2) IS
    BEGIN
        -- use_current_session=>false 走调度器后台跑，不卡当前会话
        DBMS_SCHEDULER.RUN_JOB(job_name => is_job_name, use_current_session => FALSE);

        MFG_ERP.F_EXC.log_error(
            is_error_code  => 'I9003',
            is_module      => MFG_ERP.F_CONST.c_mod_sched,
            is_procedure   => 'run_job_now',
            is_error_msg   => '手工触发作业 ' || is_job_name,
            is_biz_key     => is_job_name,
            is_error_level => 'INFO');
    EXCEPTION
        WHEN OTHERS THEN
            -- -27475 作业不存在时给业务错误，比裸 ORA 更可读
            IF SQLCODE = -27475 THEN
                MFG_ERP.F_EXC.raise_biz_error(
                    MFG_ERP.F_CONST.c_err_system, MFG_ERP.F_CONST.c_mod_sched, 'run_job_now',
                    '作业不存在 ' || is_job_name, is_job_name);
            ELSE
                RAISE;
            END IF;
    END run_job_now;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：drop_job
    *****************************************************************/
    PROCEDURE drop_job(is_job_name IN VARCHAR2) IS
    BEGIN
        -- force=>true: 即便作业正在运行也强制停掉再删
        DBMS_SCHEDULER.DROP_JOB(job_name => is_job_name, force => TRUE);

        MFG_ERP.F_EXC.log_error(
            is_error_code  => 'I9004',
            is_module      => MFG_ERP.F_CONST.c_mod_sched,
            is_procedure   => 'drop_job',
            is_error_msg   => '删除作业 ' || is_job_name,
            is_biz_key     => is_job_name,
            is_error_level => 'INFO');
    EXCEPTION
        WHEN OTHERS THEN
            -- 作业本就不存在(已删/未建)按成功处理，调用方不必先判存在
            IF SQLCODE IN (-27475, -27476) THEN
                NULL;
            ELSE
                RAISE;
            END IF;
    END drop_job;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：list_jobs
    *****************************************************************/
    PROCEDURE list_jobs(or_cur OUT SYS_REFCURSOR) IS
    BEGIN
        -- 只看本应用前缀的作业，左连最近一次运行明细取上次结果
        -- 同一作业 job_run_details 会有多条历史，用 row_number 取每作业最新一条
        OPEN or_cur FOR
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

END f_sched;
