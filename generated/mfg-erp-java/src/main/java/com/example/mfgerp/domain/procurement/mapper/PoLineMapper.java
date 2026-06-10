package com.example.mfgerp.domain.procurement.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.domain.procurement.entity.PoLine;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.math.BigDecimal;

@Mapper
public interface PoLineMapper extends BaseMapper<PoLine> {

    /**
     * 翻译自 PROCUREMENT_PKG — SELECT ... FOR UPDATE
     * 对应 PL/SQL: select * into v_line from t_po_line where po_id = p_po_id and line_no = p_line_no for update
     */
    @Select("SELECT * FROM t_po_line WHERE po_id = #{poId} AND line_no = #{lineNo} FOR UPDATE")
    PoLine selectForUpdate(@Param("poId") Long poId, @Param("lineNo") BigDecimal lineNo);

    /**
     * 翻译自 PROCUREMENT_PKG — 取当前最大行号
     * 对应 PL/SQL: select nvl(max(line_no), 0) into v_max from t_po_line where po_id = p_po_id
     */
    @Select("SELECT COALESCE(MAX(line_no), 0) FROM t_po_line WHERE po_id = #{poId}")
    BigDecimal selectMaxLineNo(@Param("poId") Long poId);
}
