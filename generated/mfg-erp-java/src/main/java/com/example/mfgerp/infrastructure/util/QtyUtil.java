package com.example.mfgerp.infrastructure.util;

import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * Translated from UTIL_PKG rounding/precision utilities.
 * Centralizes quantity rounding logic used across all domain services.
 */
public final class QtyUtil {

    private QtyUtil() {}

    private static final int DEFAULT_QTY_SCALE = 4;
    private static final int DEFAULT_COST_SCALE = 6;

    public static BigDecimal roundQty(BigDecimal qty) {
        return qty.setScale(DEFAULT_QTY_SCALE, RoundingMode.HALF_UP);
    }

    public static BigDecimal roundCost(BigDecimal cost) {
        return cost.setScale(DEFAULT_COST_SCALE, RoundingMode.HALF_UP);
    }

    public static BigDecimal roundAmount(BigDecimal amount) {
        return amount.setScale(4, RoundingMode.HALF_UP);
    }

    public static boolean isPositive(BigDecimal qty) {
        return qty != null && qty.compareTo(BigDecimal.ZERO) > 0;
    }

    public static boolean isNonNegative(BigDecimal qty) {
        return qty != null && qty.compareTo(BigDecimal.ZERO) >= 0;
    }
}
