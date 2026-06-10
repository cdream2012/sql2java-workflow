package com.example.mfgerp.application.report.dto;

import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;

/**
 * Stock aging report row.
 * Translated from REPORT_PKG.stock_aging.
 */
@Data
public class StockAgingVO {

    private Long itemId;
    private String itemCode;
    private String itemName;
    private Long warehouseId;
    private String warehouseCode;
    private String lotNo;
    private BigDecimal qtyOnHand;
    private BigDecimal unitCost;
    private BigDecimal totalValue;
    private LocalDate receiptDate;
    private BigDecimal ageDays;
    private String agingBucket;
}
