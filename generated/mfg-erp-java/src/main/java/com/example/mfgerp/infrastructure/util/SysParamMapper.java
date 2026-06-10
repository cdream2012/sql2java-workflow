package com.example.mfgerp.infrastructure.util;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.infrastructure.entity.AppParam;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface SysParamMapper extends BaseMapper<AppParam> {

    /**
     * 翻译自 UTIL_PKG.get_param 中的 SELECT
     * 对应 PL/SQL: select param_value into v_val from t_app_param where param_key = p_key;
     */
    @Select("SELECT param_value FROM t_app_param WHERE param_key = #{key}")
    String selectParamValueByKey(@Param("key") String key);
}
