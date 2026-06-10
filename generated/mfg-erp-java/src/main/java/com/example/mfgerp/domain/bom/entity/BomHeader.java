package com.example.mfgerp.domain.bom.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

@Data
@TableName("t_bom_header")
public class BomHeader {

    @TableId(type = IdType.ASSIGN_ID)
    private Long bomId;

    private Long itemId;
    private String bomVersion;
    private BigDecimal baseQty;
    private String baseUom;
    private String status;
    private String isDefault;
    private LocalDate effectiveFrom;
    private LocalDate effectiveTo;
    private String createdBy;
    private LocalDateTime createdAt;
}
