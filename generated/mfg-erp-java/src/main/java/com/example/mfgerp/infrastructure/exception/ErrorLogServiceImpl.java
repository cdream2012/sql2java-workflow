package com.example.mfgerp.infrastructure.exception;

import com.example.mfgerp.infrastructure.entity.ErrorLog;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;

/**
 * 翻译自 EXC_PKG.log_error
 * 使用 REQUIRES_NEW 模拟 Oracle 自治事务：主流程 rollback 不带走日志
 */
@Service
@RequiredArgsConstructor
public class ErrorLogServiceImpl implements ErrorLogService {

    private static final Logger log = LoggerFactory.getLogger(ErrorLogServiceImpl.class);

    private final ErrorLogMapper errorLogMapper;

    /**
     * 翻译自 EXC_PKG.log_error
     * 对应 PL/SQL:
     *   insert into t_error_log (...) values (seq_error_log_id.nextval, ...);
     *   commit;
     */
    @Override
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void logError(String errorCode, String module, String procedure,
                         String errorMsg, String bizKey, String contextData, String errorLevel) {
        try {
            ErrorLog errorLog = new ErrorLog();
            errorLog.setErrorCode(errorCode);
            errorLog.setErrorLevel(errorLevel);
            errorLog.setModuleName(module);
            errorLog.setProcedureName(procedure);
            // 对应 PL/SQL: substr(p_error_msg, 1, 2000)
            errorLog.setErrorMsg(errorMsg != null && errorMsg.length() > 2000
                    ? errorMsg.substring(0, 2000) : errorMsg);
            // 对应 PL/SQL: format_error_stack()
            errorLog.setErrorStack(formatErrorStack());
            errorLog.setBizKey(bizKey);
            errorLog.setContextData(contextData);
            // 对应 PL/SQL: nvl(sys_context('userenv','session_user'), 'SYSTEM')
            errorLog.setOperator(getCurrentOperator());
            // 对应 PL/SQL: current_timestamp
            errorLog.setOccurredAt(LocalDateTime.now());

            errorLogMapper.insert(errorLog);

            // 对应 PL/SQL: if g_debug_on then dbms_output.put_line(...)
            log.debug("[{}] {}.{} {}: {}", errorLevel, module, procedure, errorCode, errorMsg);
        } catch (Exception e) {
            // 对应 PL/SQL: when others then rollback; dbms_output.put_line('[FATAL] exc_pkg.log_error self-failed: ' || sqlerrm);
            log.error("[FATAL] ErrorLogService.logError self-failed: {}", e.getMessage(), e);
        }
    }

    /**
     * 翻译自 EXC_PKG.format_error_stack
     * 对应 PL/SQL:
     *   return 'SQLCODE=' || sqlcode || chr(10)
     *       || 'SQLERRM=' || sqlerrm || chr(10)
     *       || 'BACKTRACE=' || dbms_utility.format_error_backtrace || chr(10)
     *       || 'CALL_STACK=' || dbms_utility.format_call_stack;
     * Java 中通过 Thread.currentThread().getStackTrace() 获取调用栈
     */
    private String formatErrorStack() {
        try {
            StringBuilder sb = new StringBuilder();
            sb.append("CALL_STACK=");
            StackTraceElement[] stackTrace = Thread.currentThread().getStackTrace();
            for (int i = 2; i < Math.min(stackTrace.length, 20); i++) {
                sb.append("\n  at ").append(stackTrace[i].toString());
            }
            return sb.toString();
        } catch (Exception e) {
            return "FORMAT_STACK_FAILED: " + e.getMessage();
        }
    }

    /**
     * 获取当前操作人
     * 对应 PL/SQL: nvl(sys_context('userenv','session_user'), 'SYSTEM')
     */
    private String getCurrentOperator() {
        // TODO: [translate] 应从 SecurityContext 或 ThreadLocal 获取当前用户
        return "SYSTEM";
    }
}
