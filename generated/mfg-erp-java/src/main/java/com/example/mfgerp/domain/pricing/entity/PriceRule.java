package com.example.mfgerp.domain.pricing.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;

@Data
@TableName("t_price_rule")
public class PriceRule {

    @TableId(type = IdType.ASSIGN_ID)
    private Long ruleId;

    private Long priceListId;
    private Long itemId;
    private Long categoryId;
    private Long customerId;
    private BigDecimal minQty;
    private BigDecimal maxQty;
    private String ruleType;
    private BigDecimal priceValue;
    private BigDecimal priority;
    private LocalDate validFrom;
    private LocalDate validTo;
    private String isActive;
}
