package com.example.mfgerp.infrastructure.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;

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
