package com.example.mfgerp.domain.bom.dto;

import lombok.Data;

import java.math.BigDecimal;

/**
 * Translated from Oracle object type T_EXPLOSION (element of T_EXPLOSION_TAB).
 * Represents a single row in a BOM explosion result.
 */
@Data
public class ExplosionRowVO {

    private Long itemId;
    private String itemCode;
    private String itemName;
    private Integer levelNo;
    private BigDecimal qtyPer;
    private BigDecimal effectiveQty;
    private BigDecimal scrapRate;
    private String uom;
    private String isPhantom;
    private BigDecimal unitCost;
    private BigDecimal extendedCost;
    private Long parentItemId;
    private String parentItemCode;
}
