package com.example.mfgerp.infrastructure.util;

import com.example.mfgerp.infrastructure.entity.BusinessDate;
import com.example.mfgerp.infrastructure.exception.BusinessException;
import com.example.mfgerp.infrastructure.exception.ErrorCode;
import com.example.mfgerp.constant.AppConstants;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.stereotype.Service;

import java.time.LocalDate;

/**
 * 翻译自 UTIL_PKG 业务日期相关函数
 * 包级变量 g_curr_biz_date / g_last_biz_date / g_next_biz_date → Caffeine 缓存
 */
@Service
@RequiredArgsConstructor
public class BizDateServiceImpl implements BizDateService {

    private static final Logger log = LoggerFactory.getLogger(BizDateServiceImpl.class);

    private final BizDateMapper bizDateMapper;

    /**
     * 翻译自 UTIL_PKG.refresh_biz_date
     * 对应 PL/SQL:
     *   select curr_biz_date, last_biz_date, next_biz_date
     *     into g_curr_biz_date, g_last_biz_date, g_next_biz_date
     *     from t_business_date where sys_code = 'CORE';
     *   exception when no_data_found then
     *     exc_pkg.raise_biz_error(c_err_system, c_mod_util, 'refresh_biz_date', '...');
     */
    @Override
    @CacheEvict(value = "bizDate", allEntries = true)
    public void refreshBizDate() {
        try {
            BusinessDate bd = bizDateMapper.selectBizDate();
            // 缓存通过 @Cacheable 自动管理，此处只做验证
            log.debug("业务日期已刷新: curr={}, last={}, next={}",
                    bd.getCurrBizDate(), bd.getLastBizDate(), bd.getNextBizDate());
        } catch (EmptyResultDataAccessException e) {
            throw new BusinessException(ErrorCode.SYSTEM_ERROR,
                    AppConstants.C_MOD_UTIL, "refreshBizDate",
                    "业务日期表 t_business_date(sys_code=CORE) 未初始化");
        }
    }

    /**
     * 翻译自 UTIL_PKG.curr_biz_date
     * 对应 PL/SQL:
     *   if g_curr_biz_date is null then refresh_biz_date; end if;
     *   return g_curr_biz_date;
     */
    @Override
    @Cacheable(value = "bizDate", key = "'curr'")
    public LocalDate currBizDate() {
        BusinessDate bd = bizDateMapper.selectBizDate();
        return bd.getCurrBizDate();
    }

    /**
     * 翻译自 UTIL_PKG.last_biz_date
     * 对应 PL/SQL:
     *   if g_last_biz_date is null then refresh_biz_date; end if;
     *   return g_last_biz_date;
     */
    @Override
    @Cacheable(value = "bizDate", key = "'last'")
    public LocalDate lastBizDate() {
        BusinessDate bd = bizDateMapper.selectBizDate();
        return bd.getLastBizDate();
    }

    /**
     * 翻译自 UTIL_PKG.next_biz_date
     * 对应 PL/SQL:
     *   if g_next_biz_date is null then refresh_biz_date; end if;
     *   return g_next_biz_date;
     */
    @Override
    @Cacheable(value = "bizDate", key = "'next'")
    public LocalDate nextBizDate() {
        BusinessDate bd = bizDateMapper.selectBizDate();
        return bd.getNextBizDate();
    }
}
