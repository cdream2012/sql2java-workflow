package com.example.mfgerp.domain.procurement.dto;

import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;

/**
 * Purchase order view object for list/detail display.
 */
@Data
public class PoVO {

    private Long poId;
    private String poNo;
    private Long supplierId;
    private String supplierName;
    private LocalDate orderDate;
    private LocalDate expectedDate;
    private String status;
    private String currencyCode;
    private BigDecimal totalAmount;
    private Long warehouseId;
    private String warehouseCode;
}
