package com.example.mfgerp.infrastructure.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;

@Data
@TableName("t_uom")
public class Uom {

    @TableId(type = IdType.INPUT)
    private String uomCode;

    private String uomName;
    private String uomCategory;
    private BigDecimal decimalDigits;
    private String isBase;
}
