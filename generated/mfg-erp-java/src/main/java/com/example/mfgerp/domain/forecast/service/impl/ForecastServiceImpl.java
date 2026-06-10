package com.example.mfgerp.domain.forecast.service.impl;

import com.example.mfgerp.constant.AppConstants;
import com.example.mfgerp.domain.forecast.dto.ForecastVO;
import com.example.mfgerp.domain.forecast.entity.DemandForecast;
import com.example.mfgerp.domain.forecast.mapper.ForecastMapper;
import com.example.mfgerp.domain.forecast.service.ForecastService;
import com.example.mfgerp.infrastructure.exception.BusinessException;
import com.example.mfgerp.infrastructure.exception.ErrorCode;
import com.example.mfgerp.infrastructure.util.BizDateService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

/**
 * 翻译自 FORECAST_PKG
 * 预测: 时序生成 / 精度分析 / 动态透视
 * 注意: Oracle MODEL 子句无法直译，用 Java 时序算法替代
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ForecastServiceImpl implements ForecastService {

    private final ForecastMapper forecastMapper;
    private final BizDateService bizDateService;

    /**
     * 翻译自 FORECAST_PKG.generate_forecast
     * 对应 PL/SQL: MODEL 子句 → Java 时序算法
     * Oracle MODEL 子句用于行列转换和递归规则计算，
     * Java 中使用 Mapper SQL + Java 逻辑实现
     */
    @Override
    @Transactional
    public void generateForecast(LocalDate runDate, String method, int periodsAhead) {
        LocalDate effectiveDate = runDate != null ? runDate : bizDateService.currBizDate();

        // TODO: [translate] MODEL 子句需要用 Java 时序算法替代
        // 当前实现: 委托给 Mapper SQL 做基础移动平均预测
        forecastMapper.generateForecast(effectiveDate, method, periodsAhead);
    }

    @Override
    public List<ForecastVO> forecastAccuracy(Long itemId) {
        return forecastMapper.forecastAccuracy(itemId);
    }

    /**
     * 翻译自 FORECAST_PKG.pivot_demand_dynamic
     * 对应 PL/SQL: DBMS_SQL 动态 PIVOT → Java 动态查询构建
     */
    @Override
    public List<Map<String, Object>> pivotDemandDynamic(LocalDate fromPeriod, LocalDate toPeriod) {
        // TODO: [translate] DBMS_SQL 动态 PIVOT 需要动态查询构建
        return forecastMapper.pivotDemandDynamic(fromPeriod, toPeriod);
    }
}
