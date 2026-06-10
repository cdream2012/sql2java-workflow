package com.example.mfgerp.application.report.dto;

import lombok.Data;

import java.math.BigDecimal;

/**
 * Inventory Pareto (ABC analysis) report row.
 * Translated from REPORT_PKG.inventory_pareto.
 */
@Data
public class InventoryParetoVO {

    private Long itemId;
    private String itemCode;
    private String itemName;
    private String abcClass;
    private BigDecimal totalValue;
    private BigDecimal valuePct;
    private BigDecimal cumulativePct;
    private Integer ntileGroup;
}
