package com.example.mfgerp.application.report.service;

import com.example.mfgerp.application.report.dto.*;

import java.util.List;

/**
 * Translated from REPORT_PKG.
 * All report methods are read-only queries.
 */
public interface ReportService {

    String bomComponentListJson(Long bomId);

    List<BomComponentReportVO> bomComponentList(Long bomId);

    List<InventoryByWarehouseVO> inventoryByWarehouse();

    List<SalesSummaryVO> salesSummary();

    List<StockAgingVO> stockAging();

    List<TopConsumedItemVO> topConsumedItems();

    List<InventoryParetoVO> inventoryPareto();
}
