package com.example.mfgerp.domain.procurement.service;

import com.example.mfgerp.domain.procurement.dto.PoVO;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

/**
 * Translated from PROCUREMENT_PKG.
 */
public interface PurchaseOrderService {

    Long createPo(Long supplierId, Long warehouseId, LocalDate expectedDate);

    void addPoLine(Long poId, Long itemId, BigDecimal qty, BigDecimal unitPrice, String uom, LocalDate needDate);

    void approvePo(Long poId);

    void receivePoLine(Long poId, BigDecimal lineNo, BigDecimal qty, BigDecimal unitCost);

    int createPoFromMrp(Long runId);

    int reorderScan(Long warehouseId);

    List<PoVO> supplierRanking(LocalDate fromDate, LocalDate toDate);

    void cancelPo(Long poId, String reason);
}
