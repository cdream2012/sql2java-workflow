package com.example.mfgerp.domain.inventory.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.domain.inventory.entity.InventoryTxn;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.math.BigDecimal;
import java.time.LocalDate;

@Mapper
public interface InventoryTxnMapper extends BaseMapper<InventoryTxn> {

    /**
     * 翻译自 INVENTORY_PKG.archive_txns_before
     * 对应 PL/SQL: execute immediate 'create table ' || v_tab || ' as select * from t_inventory_txn where 1 = 0'
     */
    void createArchiveTable(@Param("tableName") String tableName);

    /**
     * 翻译自 INVENTORY_PKG.archive_txns_before
     * 对应 PL/SQL: execute immediate 'insert into ' || v_tab || ' select * from t_inventory_txn where txn_date < :1'
     */
    int archiveToTable(@Param("tableName") String tableName, @Param("beforeDate") LocalDate beforeDate);

    /**
     * 翻译自 INVENTORY_PKG.archive_txns_before
     * 对应 PL/SQL: execute immediate 'delete from t_inventory_txn where txn_date < :1'
     */
    int deleteArchived(@Param("beforeDate") LocalDate beforeDate);

    /**
     * 按条件更新流水类型和备注
     * 对应 PL/SQL adjust_stock/transfer_stock 中的:
     *   update t_inventory_txn set txn_type = :newType, remark = :remark
     *    where item_id = :itemId and warehouse_id = :warehouseId
     *      and txn_type = :oldType and txn_date = :txnDate
     *      and ref_doc_type = :refDocType
     */
    int updateTxnTypeByCriteria(@Param("itemId") Long itemId,
                                @Param("warehouseId") Long warehouseId,
                                @Param("oldType") String oldType,
                                @Param("newType") String newType,
                                @Param("txnDate") LocalDate txnDate,
                                @Param("refDocType") String refDocType,
                                @Param("remark") String remark);
}
