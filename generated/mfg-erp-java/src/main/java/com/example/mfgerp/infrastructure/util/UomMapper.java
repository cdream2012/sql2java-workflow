package com.example.mfgerp.infrastructure.util;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.infrastructure.entity.Uom;
import com.example.mfgerp.infrastructure.entity.UomConversion;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.math.BigDecimal;

@Mapper
public interface UomMapper extends BaseMapper<Uom> {

    /**
     * 翻译自 UTIL_PKG.convert_qty 中的直接换算查询
     * 对应 PL/SQL: select factor into v_factor from t_uom_conversion where from_uom = p_from_uom and to_uom = p_to_uom;
     */
    @Select("SELECT factor FROM t_uom_conversion WHERE from_uom = #{fromUom} AND to_uom = #{toUom}")
    BigDecimal getConversionFactor(@Param("fromUom") String fromUom, @Param("toUom") String toUom);

    /**
     * 翻译自 UTIL_PKG.convert_qty 中枢轴折算查询
     * 对应 PL/SQL:
     *   select f.factor / t.factor into v_factor
     *     from t_uom_conversion f
     *     join t_uom_conversion t on t.from_uom = p_to_uom and t.to_uom = f.to_uom
     *    where f.from_uom = p_from_uom and rownum = 1;
     */
    @Select("SELECT f.factor / t.factor " +
            "FROM t_uom_conversion f " +
            "JOIN t_uom_conversion t ON t.from_uom = #{toUom} AND t.to_uom = f.to_uom " +
            "WHERE f.from_uom = #{fromUom} " +
            "LIMIT 1")
    BigDecimal getPivotConversionFactor(@Param("fromUom") String fromUom, @Param("toUom") String toUom);
}
