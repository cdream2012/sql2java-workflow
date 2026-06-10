package com.example.mfgerp.infrastructure.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("t_audit_log")
public class AuditLog {

    @TableId(type = IdType.ASSIGN_ID)
    private Long auditId;

    private String tableName;
    private String actionType;
    private String bizKey;
    private String oldValue;
    private String newValue;
    private String operator;
    private LocalDateTime operatedAt;
}
