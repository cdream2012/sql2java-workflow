package com.example.mfgerp.domain.inventory.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.domain.inventory.entity.InventoryBalance;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.math.BigDecimal;
import java.time.LocalDate;

@Mapper
public interface InventoryBalanceMapper extends BaseMapper<InventoryBalance> {

    /**
     * 翻译自 INVENTORY_PKG.get_available
     * 对应 PL/SQL: select nvl(qty_on_hand - qty_allocated, 0) into v_avail from t_inventory_balance
     *   where item_id = p_item_id and warehouse_id = p_warehouse_id
     */
    @Select("SELECT COALESCE(qty_on_hand - qty_allocated, 0) FROM t_inventory_balance " +
            "WHERE item_id = #{itemId} AND warehouse_id = #{warehouseId}")
    BigDecimal getAvailable(@Param("itemId") Long itemId, @Param("warehouseId") Long warehouseId);

    /**
     * 查询余额行
     */
    @Select("SELECT item_id, warehouse_id, qty_on_hand, qty_allocated, avg_cost, " +
            "last_txn_date, version, updated_at " +
            "FROM t_inventory_balance WHERE item_id = #{itemId} AND warehouse_id = #{warehouseId}")
    InventoryBalance selectByItemAndWarehouse(@Param("itemId") Long itemId,
                                               @Param("warehouseId") Long warehouseId);

    /**
     * 翻译自 INVENTORY_PKG.sync_balance
     * 按批次实时重算余额
     */
    void syncBalanceFromLots(@Param("itemId") Long itemId,
                              @Param("warehouseId") Long warehouseId,
                              @Param("bizDate") LocalDate bizDate);
}
