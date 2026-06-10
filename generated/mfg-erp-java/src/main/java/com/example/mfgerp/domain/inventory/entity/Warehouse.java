package com.example.mfgerp.domain.inventory.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 仓库实体，对应 t_warehouse 表
 */
@Data
@TableName("t_warehouse")
public class Warehouse {

    @TableId(type = IdType.ASSIGN_ID)
    private Long warehouseId;

    private String warehouseCode;
    private String warehouseName;
    private String warehouseType;
    private String region;
    private String isActive;
    private LocalDateTime createdAt;
}
