package com.example.mfgerp.domain.mrp.dto;

import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;

/**
 * MRP plan line view object for netting detail display.
 */
@Data
public class PlanVO {

    private Long planId;
    private Long runId;
    private Long itemId;
    private String itemCode;
    private String itemName;
    private Long warehouseId;
    private LocalDate bucketDate;
    private BigDecimal levelNo;
    private BigDecimal grossReq;
    private BigDecimal scheduledReceipt;
    private BigDecimal projOnHand;
    private BigDecimal netReq;
    private BigDecimal plannedOrderQty;
    private LocalDate plannedOrderDate;
    private String actionMsg;
}
