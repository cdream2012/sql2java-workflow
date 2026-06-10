package com.example.mfgerp.domain.inventory.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

@Data
@TableName("t_inventory_lot")
public class InventoryLot {

    @TableId(type = IdType.ASSIGN_ID)
    private Long lotId;

    private String lotNo;
    private Long itemId;
    private Long warehouseId;
    private BigDecimal qtyOnHand;
    private BigDecimal qtyAllocated;
    private BigDecimal unitCost;
    private String currencyCode;
    private LocalDate receiptDate;
    private LocalDate expiryDate;
    private String status;
    private String sourceDocType;
    private Long sourceDocId;
    private LocalDateTime createdAt;
}
