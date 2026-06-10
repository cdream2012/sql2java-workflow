package com.example.mfgerp.domain.pricing.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;

@Data
@TableName("t_price_list")
public class PriceList {

    @TableId(type = IdType.ASSIGN_ID)
    private Long priceListId;

    private String listCode;
    private String listName;
    private String currencyCode;
    private String isDefault;
    private LocalDate validFrom;
    private LocalDate validTo;
    private String isActive;
}
