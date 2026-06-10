package com.example.mfgerp.domain.mrp.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDate;

@Data
@TableName("t_mrp_plan")
public class MrpPlan {

    @TableId(type = IdType.ASSIGN_ID)
    private Long planId;

    private Long runId;
    private Long itemId;
    private Long warehouseId;
    private LocalDate bucketDate;
    private BigDecimal levelNo;
    private BigDecimal grossReq;
    private BigDecimal scheduledReceipt;
    private BigDecimal projOnHand;
    private BigDecimal netReq;
    private BigDecimal plannedOrderQty;
    private LocalDate plannedOrderDate;
    private String actionMsg;
}
