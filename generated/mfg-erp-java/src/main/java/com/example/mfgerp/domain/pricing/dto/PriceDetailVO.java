package com.example.mfgerp.domain.pricing.dto;

import lombok.Data;

import java.math.BigDecimal;

/**
 * Translated from PRICING_PKG.get_price_detail output parameters.
 */
@Data
public class PriceDetailVO {

    private BigDecimal basePrice;
    private BigDecimal finalPrice;
    private Long ruleId;
    private String ruleType;
    private Long priceListId;
    private String priceListCode;
}
