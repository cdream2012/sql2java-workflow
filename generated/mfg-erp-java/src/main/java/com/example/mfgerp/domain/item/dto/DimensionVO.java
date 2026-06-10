package com.example.mfgerp.domain.item.dto;

import lombok.Data;

import java.math.BigDecimal;
import java.util.List;

/**
 * Translated from Oracle object type T_DIMENSION.
 */
@Data
public class DimensionVO {

    private BigDecimal lengthCm;
    private BigDecimal widthCm;
    private BigDecimal heightCm;
    private BigDecimal weightKg;
    private BigDecimal volumeCm3;
    private BigDecimal volumetricWeightKg;
}
