package com.example.mfgerp.domain.item.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;

@Data
@TableName("t_item_category")
public class ItemCategory {

    @TableId(type = IdType.ASSIGN_ID)
    private Long categoryId;

    private Long parentCategoryId;
    private String categoryCode;
    private String categoryName;
    private BigDecimal levelNo;
    private String path;
    private String isLeaf;
}
