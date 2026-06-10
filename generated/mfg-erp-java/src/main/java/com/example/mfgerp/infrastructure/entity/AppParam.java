package com.example.mfgerp.infrastructure.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("t_app_param")
public class AppParam {

    @TableId(type = IdType.INPUT)
    private String paramKey;

    private String paramValue;
    private String paramType;
    private String description;
    private String updatedBy;
    private LocalDateTime updatedAt;
}
