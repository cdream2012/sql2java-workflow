package com.example.mfgerp.domain.forecast.dto;

import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;

/**
 * Forecast view object for display and reporting.
 */
@Data
public class ForecastVO {

    private Long forecastId;
    private Long itemId;
    private String itemCode;
    private String itemName;
    private Long warehouseId;
    private LocalDate periodDate;
    private BigDecimal forecastQty;
    private BigDecimal actualQty;
    private String method;
    private BigDecimal accuracyPct;
    private BigDecimal mape;
}
