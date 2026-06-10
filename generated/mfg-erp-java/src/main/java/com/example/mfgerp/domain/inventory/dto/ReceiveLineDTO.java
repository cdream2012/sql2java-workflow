package com.example.mfgerp.domain.inventory.dto;

import lombok.Data;

import java.math.BigDecimal;

/**
 * Translated from Oracle PL/SQL record t_recv_line (element of T_RECV_TAB).
 * Used in INVENTORY_PKG.bulk_receive.
 */
@Data
public class ReceiveLineDTO {

    private Long itemId;
    private Long warehouseId;
    private BigDecimal qty;
    private BigDecimal unitCost;
    private String lotNo;
    private String refDocType;
    private Long refDocId;
}
