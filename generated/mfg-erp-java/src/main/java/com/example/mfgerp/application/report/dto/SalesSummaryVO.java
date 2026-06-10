package com.example.mfgerp.application.report.dto;

import lombok.Data;

import java.math.BigDecimal;

/**
 * Sales summary report row (ROLLUP/CUBE + GROUPING_ID).
 * Translated from REPORT_PKG.sales_summary.
 */
@Data
public class SalesSummaryVO {

    private String groupingLevel;
    private Long customerId;
    private String customerName;
    private String itemCode;
    private String itemName;
    private BigDecimal totalQty;
    private BigDecimal totalAmount;
    private BigDecimal discountAmount;
    private BigDecimal netAmount;
}
