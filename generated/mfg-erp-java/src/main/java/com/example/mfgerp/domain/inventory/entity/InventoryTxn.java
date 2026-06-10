package com.example.mfgerp.domain.inventory.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

@Data
@TableName("t_inventory_txn")
public class InventoryTxn {

    @TableId(type = IdType.ASSIGN_ID)
    private Long txnId;

    private String txnNo;
    private Long itemId;
    private Long warehouseId;
    private Long lotId;
    private String txnType;
    private String direction;
    private BigDecimal quantity;
    private BigDecimal unitCost;
    private BigDecimal totalCost;
    private BigDecimal qtyBefore;
    private BigDecimal qtyAfter;
    private LocalDate txnDate;
    private LocalDateTime txnTime;
    private String refDocType;
    private Long refDocId;
    private String operator;
    private String remark;
    private LocalDateTime createdAt;
}
