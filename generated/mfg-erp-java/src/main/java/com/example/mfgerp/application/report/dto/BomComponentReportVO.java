package com.example.mfgerp.application.report.dto;

import lombok.Data;

import java.math.BigDecimal;

/**
 * BOM component list report row (JSON output).
 * Translated from REPORT_PKG.bom_component_list.
 */
@Data
public class BomComponentReportVO {

    private Long bomId;
    private String bomVersion;
    private String itemCode;
    private String itemName;
    private Long componentItemId;
    private String componentCode;
    private String componentName;
    private BigDecimal qtyPer;
    private BigDecimal effectiveQty;
    private BigDecimal scrapRate;
    private String uom;
}
