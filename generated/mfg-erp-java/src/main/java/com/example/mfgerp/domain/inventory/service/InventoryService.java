package com.example.mfgerp.domain.inventory.service;

import com.example.mfgerp.domain.inventory.dto.AllocationVO;
import com.example.mfgerp.domain.inventory.dto.ReceiveLineDTO;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

/**
 * Translated from INVENTORY_PKG.
 */
public interface InventoryService {

    void receiveStock(Long itemId, Long warehouseId, BigDecimal qty, BigDecimal unitCost,
                      String lotNo, String refDocType, Long refDocId);

    void receiveStockByCode(String itemCode, String warehouseCode, BigDecimal qty,
                            BigDecimal unitCost, String lotNo);

    List<AllocationVO> issueStock(Long itemId, Long warehouseId, BigDecimal qty,
                                   String refDocType, Long refDocId);

    int[] bulkReceive(List<ReceiveLineDTO> lines);

    void adjustStock(Long itemId, Long warehouseId, BigDecimal newQty, String reason);

    void transferStock(Long itemId, Long fromWh, Long toWh, BigDecimal qty);

    void syncBalance(Long itemId, Long warehouseId);

    BigDecimal getAvailable(Long itemId, Long warehouseId);

    int archiveTxnsBefore(LocalDate beforeDate);
}
