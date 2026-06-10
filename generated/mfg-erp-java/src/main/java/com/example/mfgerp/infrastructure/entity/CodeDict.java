package com.example.mfgerp.infrastructure.entity;

import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import lombok.Data;

import java.math.BigDecimal;

@Data
@TableName("t_code_dict")
public class CodeDict {

    @TableId(type = IdType.INPUT)
    private String dictType;
    private String code;
    private String codeName;
    private BigDecimal sortNo;
    private String attr1;
    private String attr2;
    private String isActive;
    private String remark;
}
