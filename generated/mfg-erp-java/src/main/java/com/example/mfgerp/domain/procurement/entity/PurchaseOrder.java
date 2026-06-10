package com.example.mfgerp.domain.procurement.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

@Data
@TableName("t_purchase_order")
public class PurchaseOrder {

    @TableId(type = IdType.ASSIGN_ID)
    private Long poId;

    private String poNo;
    private Long supplierId;
    private LocalDate orderDate;
    private LocalDate expectedDate;
    private String status;
    private String currencyCode;
    private BigDecimal totalAmount;
    private Long warehouseId;
    private String createdBy;
    private String approvedBy;
    private LocalDateTime approvedAt;
    private LocalDateTime createdAt;
}
