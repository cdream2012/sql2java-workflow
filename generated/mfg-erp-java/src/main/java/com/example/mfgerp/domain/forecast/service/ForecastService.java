package com.example.mfgerp.domain.forecast.service;

import com.example.mfgerp.domain.forecast.dto.ForecastVO;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

/**
 * Translated from FORECAST_PKG.
 */
public interface ForecastService {

    void generateForecast(LocalDate runDate, String method, int periodsAhead);

    List<ForecastVO> forecastAccuracy(Long itemId);

    List<Map<String, Object>> pivotDemandDynamic(LocalDate fromPeriod, LocalDate toPeriod);
}
