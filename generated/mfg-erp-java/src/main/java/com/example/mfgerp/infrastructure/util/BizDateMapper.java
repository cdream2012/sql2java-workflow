package com.example.mfgerp.infrastructure.util;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.infrastructure.entity.BusinessDate;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface BizDateMapper extends BaseMapper<BusinessDate> {

    /**
     * 翻译自 UTIL_PKG.refresh_biz_date 的 SELECT
     * 对应 PL/SQL:
     *   select curr_biz_date, last_biz_date, next_biz_date
     *     from t_business_date where sys_code = 'CORE'
     */
    @Select("SELECT sys_code, curr_biz_date, last_biz_date, next_biz_date, period_status, updated_at " +
            "FROM t_business_date WHERE sys_code = 'CORE'")
    BusinessDate selectBizDate();
}
