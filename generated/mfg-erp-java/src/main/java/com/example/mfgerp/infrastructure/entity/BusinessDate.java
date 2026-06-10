package com.example.mfgerp.infrastructure.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalDateTime;

@Data
@TableName("t_business_date")
public class BusinessDate {

    @TableId(type = IdType.INPUT)
    private String sysCode;

    private LocalDate currBizDate;
    private LocalDate lastBizDate;
    private LocalDate nextBizDate;
    private String periodStatus;
    private LocalDateTime updatedAt;
}
