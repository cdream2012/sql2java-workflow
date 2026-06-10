package com.example.mfgerp.infrastructure.util;

import java.math.BigDecimal;
import java.time.LocalDate;

/**
 * Translated from UTIL_PKG.get_param (overloaded).
 * Provides typed parameter access with Caffeine caching.
 */
public interface SysParamService {

    String getParam(String key, String defaultValue);

    BigDecimal getParam(String key, BigDecimal defaultValue);

    LocalDate getParam(String key, LocalDate defaultValue);
}
