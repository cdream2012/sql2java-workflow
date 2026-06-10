package com.example.mfgerp.infrastructure.util;

import com.example.mfgerp.infrastructure.entity.AppParam;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;

/**
 * 翻译自 UTIL_PKG.get_param（重载版本）
 * PL/SQL 有三个同名 get_param 按默认值类型区分，Java 用方法重载实现
 */
@Service
@RequiredArgsConstructor
public class SysParamServiceImpl implements SysParamService {

    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd");

    private final SysParamMapper sysParamMapper;

    /**
     * 翻译自 UTIL_PKG.get_param(p_key, p_default VARCHAR2) return VARCHAR2
     * 对应 PL/SQL:
     *   select param_value into v_val from t_app_param where param_key = p_key;
     *   return nvl(v_val, p_default);
     *   exception when no_data_found then return p_default;
     */
    @Override
    @Cacheable(value = "sysParam", key = "#key")
    public String getParam(String key, String defaultValue) {
        try {
            String val = sysParamMapper.selectParamValueByKey(key);
            return val != null ? val : defaultValue;
        } catch (EmptyResultDataAccessException e) {
            return defaultValue;
        }
    }

    /**
     * 翻译自 UTIL_PKG.get_param(p_key, p_default NUMBER) return NUMBER
     * 对应 PL/SQL:
     *   select param_value into v_val from t_app_param where param_key = p_key;
     *   return nvl(to_number(v_val), p_default);
     *   exception when value_error then
     *     exc_pkg.log_error(...); return p_default;
     */
    @Override
    @Cacheable(value = "sysParam", key = "#key + '_NUM'")
    public BigDecimal getParam(String key, BigDecimal defaultValue) {
        try {
            String val = sysParamMapper.selectParamValueByKey(key);
            if (val == null || val.isBlank()) {
                return defaultValue;
            }
            return new BigDecimal(val);
        } catch (EmptyResultDataAccessException e) {
            return defaultValue;
        } catch (NumberFormatException e) {
            // 对应 PL/SQL: when value_error then
            // exc_pkg.log_error(c_err_system, c_mod_util, 'get_param', '参数非数字...', p_key, null, 'WARN');
            logParamWarning(key, e);
            return defaultValue;
        }
    }

    /**
     * 翻译自 UTIL_PKG.get_param(p_key, p_default DATE) return DATE
     * 对应 PL/SQL:
     *   select param_value into v_val from t_app_param where param_key = p_key;
     *   return nvl(to_date(v_val, 'YYYY-MM-DD'), p_default);
     *   exception when no_data_found then return p_default;
     */
    @Override
    @Cacheable(value = "sysParam", key = "#key + '_DATE'")
    public LocalDate getParam(String key, LocalDate defaultValue) {
        try {
            String val = sysParamMapper.selectParamValueByKey(key);
            if (val == null || val.isBlank()) {
                return defaultValue;
            }
            return LocalDate.parse(val, DATE_FMT);
        } catch (EmptyResultDataAccessException e) {
            return defaultValue;
        }
    }

    /**
     * 参数非数字时的告警日志
     * 对应 PL/SQL: exc_pkg.log_error(c_err_system, c_mod_util, 'get_param', '参数非数字 key=' || p_key, p_key, null, 'WARN')
     */
    private void logParamWarning(String key, NumberFormatException e) {
        // 简化：直接用 SLF4J 记录告警，不触发 ErrorLogService 避免循环依赖
        org.slf4j.LoggerFactory.getLogger(SysParamServiceImpl.class)
                .warn("参数非数字 key={}, error={}", key, e.getMessage());
    }
}
