package com.example.mfgerp.domain.item.dto;

import lombok.Data;

import java.math.BigDecimal;

/**
 * Translated from Oracle object type T_ITEM_OBJ.
 * Full item value object including computed fields.
 */
@Data
public class ItemVO {

    private Long itemId;
    private String itemCode;
    private String itemName;
    private String itemType;
    private String baseUom;
    private BigDecimal stdCost;
    private BigDecimal listPrice;
    private String valuationMethod;
    private Boolean isStockable;
    private BigDecimal reorderPoint;
    private BigDecimal makeLeadDays;
    private String currencyCode;
    private DimensionVO dim;
}
