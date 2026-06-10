package com.example.mfgerp.application.report.mapper;

import com.example.mfgerp.application.report.dto.InventoryByWarehouseVO;
import com.example.mfgerp.application.report.dto.InventoryParetoVO;
import com.example.mfgerp.application.report.dto.StockAgingVO;
import com.example.mfgerp.application.report.dto.TopConsumedItemVO;
import org.apache.ibatis.annotations.Mapper;

import java.util.List;

@Mapper
public interface InventoryReportMapper {

    List<InventoryByWarehouseVO> inventoryByWarehouse();

    List<StockAgingVO> stockAging();

    List<TopConsumedItemVO> topConsumedItems();

    List<InventoryParetoVO> inventoryPareto();
}
