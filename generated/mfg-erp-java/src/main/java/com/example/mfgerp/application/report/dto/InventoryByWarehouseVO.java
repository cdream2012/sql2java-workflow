package com.example.mfgerp.application.report.dto;

import lombok.Data;

import java.math.BigDecimal;

/**
 * Inventory by warehouse report row.
 * Translated from REPORT_PKG.inventory_by_warehouse.
 */
@Data
public class InventoryByWarehouseVO {

    private Long warehouseId;
    private String warehouseCode;
    private String warehouseName;
    private Long itemId;
    private String itemCode;
    private String itemName;
    private BigDecimal qtyOnHand;
    private BigDecimal avgCost;
    private BigDecimal totalValue;
}
