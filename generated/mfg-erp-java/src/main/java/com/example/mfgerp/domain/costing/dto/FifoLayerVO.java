package com.example.mfgerp.domain.costing.dto;

import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;

/**
 * Represents a FIFO cost layer for costing reports.
 */
@Data
public class FifoLayerVO {

    private Long lotId;
    private String lotNo;
    private BigDecimal qtyOnHand;
    private BigDecimal unitCost;
    private BigDecimal extendedCost;
    private LocalDate receiptDate;
    private LocalDate expiryDate;
}
