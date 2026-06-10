package com.example.mfgerp.domain.forecast.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.domain.forecast.dto.ForecastVO;
import com.example.mfgerp.domain.forecast.entity.DemandForecast;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

@Mapper
public interface ForecastMapper extends BaseMapper<DemandForecast> {

    /**
     * 翻译自 FORECAST_PKG.generate_forecast
     * 对应 PL/SQL: MODEL 子句 → Java 时序算法
     * Oracle MODEL 子句用于行列转换和递归规则计算
     */
    void generateForecast(@Param("runDate") LocalDate runDate,
                          @Param("method") String method,
                          @Param("periodsAhead") int periodsAhead);

    List<ForecastVO> forecastAccuracy(@Param("itemId") Long itemId);

    List<Map<String, Object>> pivotDemandDynamic(@Param("fromPeriod") LocalDate fromPeriod,
                                                   @Param("toPeriod") LocalDate toPeriod);
}
