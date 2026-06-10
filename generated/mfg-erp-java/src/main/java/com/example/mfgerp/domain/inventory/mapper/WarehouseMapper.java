package com.example.mfgerp.domain.inventory.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.domain.inventory.entity.Warehouse;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.util.Optional;

/**
 * 仓库 Mapper，翻译自 PL/SQL 中对 t_warehouse 的查询
 */
@Mapper
public interface WarehouseMapper extends BaseMapper<Warehouse> {

    /**
     * 按仓库编码查仓库 ID
     * 对应 PL/SQL: select warehouse_id into v_wh_id from t_warehouse where warehouse_code = p_warehouse_code
     */
    Optional<Long> findIdByCode(@Param("warehouseCode") String warehouseCode);
}
