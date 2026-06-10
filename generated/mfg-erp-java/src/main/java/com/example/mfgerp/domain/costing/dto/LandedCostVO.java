package com.example.mfgerp.domain.costing.dto;

import lombok.Data;

import java.math.BigDecimal;
import java.util.List;

/**
 * Translated from COSTING_PKG.landed_cost_report output.
 * Includes WITH FUNCTION computed charge allocations.
 */
@Data
public class LandedCostVO {

    private Long poId;
    private String poNo;
    private Long poLineId;
    private Long itemId;
    private String itemCode;
    private BigDecimal qtyReceived;
    private BigDecimal unitPrice;
    private BigDecimal chargeAmount;
    private BigDecimal totalLandedCost;
    private BigDecimal landedUnitCost;
    private List<ChargeDetail> charges;

    @Data
    public static class ChargeDetail {
        private String chargeType;
        private BigDecimal chargeAmount;
        private BigDecimal allocationRatio;
    }
}
