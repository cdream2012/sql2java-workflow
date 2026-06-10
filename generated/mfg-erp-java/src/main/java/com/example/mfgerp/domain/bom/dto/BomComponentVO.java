package com.example.mfgerp.domain.bom.dto;

import lombok.Data;

import java.math.BigDecimal;

/**
 * Translated from Oracle object type T_BOM_COMP_OBJ (element of T_BOM_COMP_TAB).
 */
@Data
public class BomComponentVO {

    private Long componentItemId;
    private String componentCode;
    private String componentName;
    private BigDecimal qtyPer;
    private BigDecimal effectiveQty;
    private BigDecimal scrapRate;
    private String uom;
    private String isPhantom;
}
