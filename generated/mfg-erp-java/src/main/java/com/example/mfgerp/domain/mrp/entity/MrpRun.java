package com.example.mfgerp.domain.mrp.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalDateTime;

@Data
@TableName("t_mrp_run")
public class MrpRun {

    @TableId(type = IdType.ASSIGN_ID)
    private Long runId;

    private String runNo;
    private LocalDate runDate;
    private BigDecimal horizonDays;
    private String bucketType;
    private String status;
    private BigDecimal itemCount;
    private BigDecimal planCount;
    private LocalDateTime startedAt;
    private LocalDateTime finishedAt;
    private String createdBy;
}
