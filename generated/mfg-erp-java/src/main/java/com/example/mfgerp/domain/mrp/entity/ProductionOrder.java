package com.example.mfgerp.domain.mrp.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

@Data
@TableName("t_production_order")
public class ProductionOrder {

    @TableId(type = IdType.ASSIGN_ID)
    private Long prodId;

    private String prodNo;
    private Long itemId;
    private Long bomId;
    private BigDecimal qtyPlanned;
    private BigDecimal qtyCompleted;
    private BigDecimal qtyScrapped;
    private String status;
    private Long warehouseId;
    private LocalDate startDate;
    private LocalDate dueDate;
    private Long sourceMrpId;
    private String createdBy;
    private LocalDateTime createdAt;
}
