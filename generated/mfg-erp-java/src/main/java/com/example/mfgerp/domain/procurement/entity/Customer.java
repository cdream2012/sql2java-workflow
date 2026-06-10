package com.example.mfgerp.domain.procurement.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;

@Data
@TableName("t_customer")
public class Customer {

    @TableId(type = IdType.ASSIGN_ID)
    private Long customerId;

    private String customerCode;
    private String customerName;
    private Long priceListId;
    private BigDecimal creditLimit;
    private String currencyCode;
    private String region;
    private String status;
    private LocalDateTime createdAt;
}
