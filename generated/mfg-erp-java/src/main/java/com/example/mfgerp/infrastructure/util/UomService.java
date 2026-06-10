package com.example.mfgerp.infrastructure.util;

import java.math.BigDecimal;

/**
 * Translated from UTIL_PKG UOM conversion functions.
 * convert_qty / round_qty / format_qty with Caffeine cache.
 */
public interface UomService {

    BigDecimal convertQty(BigDecimal qty, String fromUom, String toUom);

    BigDecimal roundQty(BigDecimal qty, String uom);

    String formatQty(BigDecimal qty, String uom);
}
