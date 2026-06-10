package com.example.mfgerp.domain.forecast.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

@Data
@TableName("t_demand_forecast")
public class DemandForecast {

    @TableId(type = IdType.ASSIGN_ID)
    private Long forecastId;

    private Long itemId;
    private Long warehouseId;
    private LocalDate periodDate;
    private BigDecimal forecastQty;
    private BigDecimal actualQty;
    private String method;
    private Long runId;
    private LocalDateTime createdAt;
}
