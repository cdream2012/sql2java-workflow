package com.example.mfgerp.application.report.mapper;

import com.example.mfgerp.application.report.dto.SalesSummaryVO;
import org.apache.ibatis.annotations.Mapper;

import java.util.List;

@Mapper
public interface SalesReportMapper {

    List<SalesSummaryVO> salesSummary();
}
