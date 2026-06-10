package com.example.mfgerp.application.report.mapper;

import com.example.mfgerp.application.report.dto.BomComponentReportVO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.List;

@Mapper
public interface BomReportMapper {

    String bomComponentListJson(@Param("bomId") Long bomId);

    List<BomComponentReportVO> bomComponentList(@Param("bomId") Long bomId);
}
