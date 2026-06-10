package com.example.mfgerp.domain.pricing.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.domain.pricing.entity.PriceRule;
import com.example.mfgerp.domain.pricing.dto.PriceDetailVO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

@Mapper
public interface PriceRuleMapper extends BaseMapper<PriceRule> {

    PriceDetailVO getPriceDetail(@Param("itemId") Long itemId,
                                  @Param("customerId") Long customerId,
                                  @Param("qty") BigDecimal qty,
                                  @Param("asOf") LocalDate asOf);

    List<PriceRule> listEffectiveRules(@Param("itemId") Long itemId,
                                        @Param("customerId") Long customerId,
                                        @Param("asOf") LocalDate asOf);

    void repriceSalesOrderLines(@Param("soId") Long soId, @Param("asOf") LocalDate asOf);

    void updateSalesOrderTotal(@Param("soId") Long soId);
}
