package com.example.mfgerp.application.report.service.impl;

import com.example.mfgerp.application.report.dto.*;
import com.example.mfgerp.application.report.mapper.BomReportMapper;
import com.example.mfgerp.application.report.mapper.InventoryReportMapper;
import com.example.mfgerp.application.report.mapper.SalesReportMapper;
import com.example.mfgerp.application.report.service.ReportService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.List;

@Slf4j
@Service
@RequiredArgsConstructor
public class ReportServiceImpl implements ReportService {

    private final BomReportMapper bomReportMapper;
    private final InventoryReportMapper inventoryReportMapper;
    private final SalesReportMapper salesReportMapper;

    @Override
    public String bomComponentListJson(Long bomId) {
        // TODO: translate from REPORT_PKG.bom_component_list (JSON CLOB output)
        return bomReportMapper.bomComponentListJson(bomId);
    }

    @Override
    public List<BomComponentReportVO> bomComponentList(Long bomId) {
        return bomReportMapper.bomComponentList(bomId);
    }

    @Override
    public List<InventoryByWarehouseVO> inventoryByWarehouse() {
        return inventoryReportMapper.inventoryByWarehouse();
    }

    @Override
    public List<SalesSummaryVO> salesSummary() {
        return salesReportMapper.salesSummary();
    }

    @Override
    public List<StockAgingVO> stockAging() {
        return inventoryReportMapper.stockAging();
    }

    @Override
    public List<TopConsumedItemVO> topConsumedItems() {
        return inventoryReportMapper.topConsumedItems();
    }

    @Override
    public List<InventoryParetoVO> inventoryPareto() {
        return inventoryReportMapper.inventoryPareto();
    }
}
