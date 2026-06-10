package com.example.mfgerp.domain.pricing.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;

@Data
@TableName("t_so_line")
public class SoLine {

    @TableId(type = IdType.ASSIGN_ID)
    private Long soLineId;

    private Long soId;
    private BigDecimal lineNo;
    private Long itemId;
    private BigDecimal qtyOrdered;
    private BigDecimal qtyShipped;
    private BigDecimal unitPrice;
    private BigDecimal discountPct;
    private String uom;
    private String lineStatus;
}
