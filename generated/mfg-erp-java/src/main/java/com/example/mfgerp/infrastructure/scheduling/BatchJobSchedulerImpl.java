package com.example.mfgerp.infrastructure.scheduling;

import com.example.mfgerp.domain.forecast.service.ForecastService;
import com.example.mfgerp.domain.mrp.service.MrpService;
import com.example.mfgerp.infrastructure.exception.ErrorLogService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;

/**
 * 翻译自 SCHED_PKG
 * DBMS_SCHEDULER → Spring @Scheduled + ThreadPoolTaskScheduler
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class BatchJobSchedulerImpl implements BatchJobScheduler {

    private final MrpService mrpService;
    private final ForecastService forecastService;
    private final ErrorLogService errorLogService;
    private final ThreadPoolTaskScheduler taskScheduler;

    // 对应 PL/SQL: 管理动态创建的 job
    private final Map<String, ScheduledFuture<?>> scheduledJobs = new ConcurrentHashMap<>();

    /**
     * 翻译自 SCHED_PKG.schedule_nightly_mrp
     * 对应 PL/SQL: DBMS_SCHEDULER.CREATE_JOB 重复间隔 FREQ=DAILY
     */
    @Override
    public void scheduleNightlyMrp() {
        ScheduledFuture<?> job = taskScheduler.scheduleAtFixedRate(
                () -> {
                    try {
                        log.info("定时 MRP 运行开始");
                        mrpService.runMrp(LocalDate.now(), 30);
                        log.info("定时 MRP 运行完成");
                    } catch (Exception e) {
                        errorLogService.logError("M9999", "SCHED", "scheduleNightlyMrp",
                                "定时 MRP 失败: " + e.getMessage(), null, null, "ERROR");
                    }
                },
                java.time.Duration.ofDays(1)
        );
        scheduledJobs.put("NIGHTLY_MRP", job);
    }

    /**
     * 翻译自 SCHED_PKG.schedule_monthly_forecast
     */
    @Override
    public void scheduleMonthlyForecast() {
        ScheduledFuture<?> job = taskScheduler.scheduleAtFixedRate(
                () -> {
                    try {
                        log.info("月度预测生成开始");
                        forecastService.generateForecast(LocalDate.now(), "MOVING_AVG", 6);
                    } catch (Exception e) {
                        errorLogService.logError("M9999", "SCHED", "scheduleMonthlyForecast",
                                "月度预测失败: " + e.getMessage(), null, null, "ERROR");
                    }
                },
                java.time.Duration.ofDays(30)
        );
        scheduledJobs.put("MONTHLY_FORECAST", job);
    }

    /**
     * 翻译自 SCHED_PKG.run_job_now
     * 对应 PL/SQL: DBMS_SCHEDULER.RUN_JOB
     */
    @Override
    public void runJobNow(String jobName) {
        taskScheduler.execute(() -> {
            try {
                switch (jobName) {
                    case "NIGHTLY_MRP":
                        mrpService.runMrp(LocalDate.now(), 30);
                        break;
                    case "MONTHLY_FORECAST":
                        forecastService.generateForecast(LocalDate.now(), "MOVING_AVG", 6);
                        break;
                    default:
                        throw new IllegalArgumentException("未知作业: " + jobName);
                }
            } catch (Exception e) {
                errorLogService.logError("M9999", "SCHED", "runJobNow",
                        "手动触发作业失败 job=" + jobName + ": " + e.getMessage(),
                        jobName, null, "ERROR");
            }
        });
    }

    /**
     * 翻译自 SCHED_PKG.drop_job
     * 对应 PL/SQL: DBMS_SCHEDULER.DROP_JOB
     */
    @Override
    public void dropJob(String jobName) {
        ScheduledFuture<?> job = scheduledJobs.remove(jobName);
        if (job != null) {
            job.cancel(false);
            log.info("已取消作业: {}", jobName);
        }
    }

    /**
     * 翻译自 SCHED_PKG.list_jobs
     */
    @Override
    public void listJobs() {
        log.info("当前活跃作业: {}", scheduledJobs.keySet());
    }
}
