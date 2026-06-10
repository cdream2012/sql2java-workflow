package com.example.mfgerp.infrastructure.exception;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Translated from EXC_PKG.log_error.
 * Logs errors to T_ERROR_LOG via autonomous-transaction-style new-transaction writing.
 */
public interface ErrorLogService {

    Logger log = LoggerFactory.getLogger(ErrorLogService.class);

    /**
     * Log an error to T_ERROR_LOG.
     * Mapped from EXC_PKG.log_error(p_error_code, p_module, p_procedure, p_error_msg, p_biz_key, p_context, p_error_level).
     *
     * @param errorCode    error code (e.g. M1001)
     * @param module       module name
     * @param procedure    procedure/method name
     * @param errorMsg     human-readable error message
     * @param bizKey       business key for traceability
     * @param contextData  additional context (JSON)
     * @param errorLevel   INFO / WARN / ERROR / FATAL
     */
    void logError(String errorCode, String module, String procedure,
                  String errorMsg, String bizKey, String contextData, String errorLevel);
}
