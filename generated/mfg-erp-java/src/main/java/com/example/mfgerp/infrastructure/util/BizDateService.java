package com.example.mfgerp.infrastructure.util;

import java.time.LocalDate;

/**
 * Translated from UTIL_PKG business date functions.
 * Provides cached access to current/last/next business dates.
 */
public interface BizDateService {

    void refreshBizDate();

    LocalDate currBizDate();

    LocalDate lastBizDate();

    LocalDate nextBizDate();
}
