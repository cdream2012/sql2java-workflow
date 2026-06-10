package com.example.mfgerp.infrastructure.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("t_error_log")
public class ErrorLog {

    @TableId(type = IdType.ASSIGN_ID)
    private Long logId;

    private String errorCode;
    private String errorLevel;
    private String moduleName;
    private String procedureName;
    private String errorMsg;
    private String errorStack;
    private String bizKey;
    private String contextData;
    private String operator;
    private LocalDateTime occurredAt;
}
