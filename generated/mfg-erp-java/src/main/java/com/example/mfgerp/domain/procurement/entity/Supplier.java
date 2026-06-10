package com.example.mfgerp.domain.procurement.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;

@Data
@TableName("t_supplier")
public class Supplier {

    @TableId(type = IdType.ASSIGN_ID)
    private Long supplierId;

    private String supplierCode;
    private String supplierName;
    private BigDecimal leadTimeDays;
    private BigDecimal rating;
    private String currencyCode;
    private String taxNo;
    private String contact;
    private String status;
    private LocalDateTime createdAt;
}
