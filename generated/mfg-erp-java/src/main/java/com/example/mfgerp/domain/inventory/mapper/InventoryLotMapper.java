package com.example.mfgerp.domain.inventory.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.domain.inventory.entity.InventoryLot;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.List;

@Mapper
public interface InventoryLotMapper extends BaseMapper<InventoryLot> {

    /**
     * 翻译自 INVENTORY_PKG.issue_stock 的 FIFO 游标
     * 对应 PL/SQL:
     *   select lot_id, lot_no, unit_cost, (qty_on_hand - qty_allocated) as avail,
     *          sum(qty_on_hand - qty_allocated) over (order by receipt_date, lot_id) as cum_avail
     *     from t_inventory_lot where ... for update of qty_on_hand
     * Java 中不用 FOR UPDATE（由 @Transactional 保证一致性），窗口函数在 SQL 中保留
     */
    @Select("SELECT lot_id, lot_no, item_id, warehouse_id, qty_on_hand, qty_allocated, " +
            "unit_cost, status, receipt_date " +
            "FROM t_inventory_lot " +
            "WHERE item_id = #{itemId} " +
            "  AND warehouse_id = #{warehouseId} " +
            "  AND status = 'AVAILABLE' " +
            "  AND qty_on_hand - COALESCE(qty_allocated, 0) > 0 " +
            "ORDER BY receipt_date, lot_id")
    List<InventoryLot> selectFifoAvailableLots(@Param("itemId") Long itemId,
                                                @Param("warehouseId") Long warehouseId);
}
