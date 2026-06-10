package com.example.mfgerp.infrastructure.exception;

/**
 * Custom business exception translated from EXC_PKG.raise_biz_error.
 * Carries an ErrorCode enum for structured error handling.
 */
public class BusinessException extends RuntimeException {

    private final ErrorCode errorCode;
    private final String module;
    private final String procedure;
    private final String bizKey;

    public BusinessException(ErrorCode errorCode, String module, String procedure, String message) {
        this(errorCode, module, procedure, message, null);
    }

    public BusinessException(ErrorCode errorCode, String module, String procedure, String message, String bizKey) {
        super(message);
        this.errorCode = errorCode;
        this.module = module;
        this.procedure = procedure;
        this.bizKey = bizKey;
    }

    public BusinessException(ErrorCode errorCode, String module, String procedure, String message, Throwable cause) {
        super(message, cause);
        this.errorCode = errorCode;
        this.module = module;
        this.procedure = procedure;
        this.bizKey = null;
    }

    public ErrorCode getErrorCode() {
        return errorCode;
    }

    public String getModule() {
        return module;
    }

    public String getProcedure() {
        return procedure;
    }

    public String getBizKey() {
        return bizKey;
    }
}
