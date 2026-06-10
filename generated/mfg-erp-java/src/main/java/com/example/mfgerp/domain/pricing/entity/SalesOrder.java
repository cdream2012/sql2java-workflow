package com.example.mfgerp.domain.pricing.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

@Data
@TableName("t_sales_order")
public class SalesOrder {

    @TableId(type = IdType.ASSIGN_ID)
    private Long soId;

    private String soNo;
    private Long customerId;
    private LocalDate orderDate;
    private LocalDate requiredDate;
    private String status;
    private String currencyCode;
    private Long priceListId;
    private BigDecimal totalAmount;
    private Long warehouseId;
    private String createdBy;
    private LocalDateTime createdAt;
}
