package com.example.mfgerp.domain.bom.service;

import java.math.BigDecimal;
import java.time.LocalDate;

/**
 * Translated from BOM_PKG.rolled_cost / COSTING_PKG.roll_standard_cost.
 * Handles cost roll-up through BOM levels.
 */
public interface CostRollupService {

    BigDecimal rolledCost(Long itemId, LocalDate asOf);

    void rollStandardCost(LocalDate asOf);
}
