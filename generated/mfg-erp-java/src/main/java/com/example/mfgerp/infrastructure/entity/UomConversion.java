package com.example.mfgerp.infrastructure.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;

@Data
@TableName("t_uom_conversion")
public class UomConversion {

    @TableId(type = IdType.INPUT)
    private String fromUom;

    private String toUom;
    private BigDecimal factor;
}
