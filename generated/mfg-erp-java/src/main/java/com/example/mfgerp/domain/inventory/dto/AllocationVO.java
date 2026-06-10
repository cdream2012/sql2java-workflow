package com.example.mfgerp.domain.inventory.dto;

import lombok.Data;

import java.math.BigDecimal;

/**
 * Translated from Oracle object type T_ALLOCATION (element of T_ALLOC_TAB).
 * Result of FIFO issue allocation in INVENTORY_PKG.issue_stock.
 */
@Data
public class AllocationVO {

    private Long lotId;
    private String lotNo;
    private BigDecimal allocQty;
    private BigDecimal unitCost;
    private BigDecimal totalCost;
}
