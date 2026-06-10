package com.example.mfgerp.infrastructure.scheduling;

/**
 * Translated from SCHED_PKG.
 * Maps DBMS_SCHEDULER operations to Spring @Scheduled / Quartz.
 */
public interface BatchJobScheduler {

    void scheduleNightlyMrp();

    void scheduleMonthlyForecast();

    void runJobNow(String jobName);

    void dropJob(String jobName);

    void listJobs();
}
