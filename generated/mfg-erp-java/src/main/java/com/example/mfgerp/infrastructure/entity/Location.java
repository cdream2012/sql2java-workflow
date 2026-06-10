package com.example.mfgerp.infrastructure.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

@Data
@TableName("t_location")
public class Location {

    @TableId(type = IdType.ASSIGN_ID)
    private Long locationId;

    private Long warehouseId;
    private Long parentLocationId;
    private String locationCode;
    private String zone;
    private String isPickable;
}
