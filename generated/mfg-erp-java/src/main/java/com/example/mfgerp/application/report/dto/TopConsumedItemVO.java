package com.example.mfgerp.application.report.dto;

import lombok.Data;

import java.math.BigDecimal;

/**
 * Top consumed items report row.
 * Translated from REPORT_PKG.top_consumed_items.
 */
@Data
public class TopConsumedItemVO {

    private Integer rank;
    private Long itemId;
    private String itemCode;
    private String itemName;
    private BigDecimal totalConsumed;
    private BigDecimal totalCost;
    private BigDecimal cumulativePct;
}
