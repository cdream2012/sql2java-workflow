package com.example.mfgerp.domain.pricing.service;

import com.example.mfgerp.domain.pricing.dto.PriceDetailVO;
import com.example.mfgerp.domain.pricing.entity.PriceRule;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

/**
 * Translated from PRICING_PKG.
 */
public interface PricingService {

    BigDecimal getPrice(Long itemId, Long customerId, BigDecimal qty, LocalDate asOf);

    PriceDetailVO getPriceDetail(Long itemId, Long customerId, BigDecimal qty);

    void repriceSalesOrder(Long soId);

    List<PriceRule> listEffectiveRules(Long itemId, Long customerId);
}
