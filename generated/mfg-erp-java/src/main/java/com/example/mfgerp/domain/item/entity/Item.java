package com.example.mfgerp.domain.item.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.extension.handlers.JacksonTypeHandler;
import com.example.mfgerp.domain.item.dto.DimensionVO;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;

@Data
@TableName(value = "t_item", autoResultMap = true)
public class Item {

    @TableId(type = IdType.ASSIGN_ID)
    private Long itemId;

    private String itemCode;
    private String itemName;
    private String itemType;
    private Long categoryId;
    private String baseUom;
    private BigDecimal stdCost;
    private BigDecimal listPrice;
    private String currencyCode;
    private String valuationMethod;
    private Long preferredSupplier;
    private BigDecimal leadTimeDays;
    private BigDecimal safetyStock;
    private BigDecimal reorderPoint;
    private BigDecimal reorderQty;
    private BigDecimal shelfLifeDays;
    private String abcClass;
    private String isPhantom;
    private String isLotControlled;
    private String status;

    @TableField(typeHandler = JacksonTypeHandler.class)
    private DimensionVO dim;

    @TableField(typeHandler = JacksonTypeHandler.class)
    private List<String> tags;

    private String createdBy;
    private LocalDateTime createdAt;
    private String updatedBy;
    private LocalDateTime updatedAt;
}
