package com.example.mfgerp.domain.procurement.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;

@Data
@TableName("t_po_line")
public class PoLine {

    @TableId(type = IdType.ASSIGN_ID)
    private Long poLineId;

    private Long poId;
    private BigDecimal lineNo;
    private Long itemId;
    private BigDecimal qtyOrdered;
    private BigDecimal qtyReceived;
    private BigDecimal unitPrice;
    private String uom;
    private LocalDate needDate;
    private String lineStatus;
}
