package com.example.mfgerp.domain.costing.service;

import com.example.mfgerp.domain.costing.dto.FifoLayerVO;
import com.example.mfgerp.domain.costing.dto.LandedCostVO;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

/**
 * Translated from COSTING_PKG.
 */
public interface CostingService {

    List<FifoLayerVO> fifoLayers(Long itemId, Long warehouseId);

    List<FifoLayerVO> inventoryValue(Long warehouseId);

    void recomputeAvgCost(Long itemId, Long warehouseId);

    List<LandedCostVO> landedCostReport(Long poId);

    void rollStandardCost(LocalDate asOf);
}
