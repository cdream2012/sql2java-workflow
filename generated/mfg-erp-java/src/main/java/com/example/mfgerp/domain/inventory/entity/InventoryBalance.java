package com.example.mfgerp.domain.inventory.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.annotation.Version;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

@Data
@TableName("t_inventory_balance")
public class InventoryBalance {

    @TableId(type = IdType.INPUT)
    private Long itemId;

    private Long warehouseId;
    private BigDecimal qtyOnHand;
    private BigDecimal qtyAllocated;
    private BigDecimal avgCost;
    private LocalDate lastTxnDate;

    @Version
    private BigDecimal version;
    private LocalDateTime updatedAt;
}
