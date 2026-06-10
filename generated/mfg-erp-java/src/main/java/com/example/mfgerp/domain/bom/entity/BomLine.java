package com.example.mfgerp.domain.bom.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;

@Data
@TableName("t_bom_line")
public class BomLine {

    @TableId(type = IdType.ASSIGN_ID)
    private Long lineId;

    private Long bomId;
    private BigDecimal lineNo;
    private Long componentItemId;
    private BigDecimal qtyPer;
    private String uom;
    private BigDecimal scrapRate;
    private String isPhantom;
    private String refDesignator;
    private LocalDate effectiveFrom;
    private LocalDate effectiveTo;
}
