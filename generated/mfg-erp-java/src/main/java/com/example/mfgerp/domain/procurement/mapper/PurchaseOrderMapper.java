package com.example.mfgerp.domain.procurement.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.domain.procurement.dto.PoVO;
import com.example.mfgerp.domain.procurement.entity.PurchaseOrder;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

@Mapper
public interface PurchaseOrderMapper extends BaseMapper<PurchaseOrder> {

    /**
     * 翻译自 PROCUREMENT_PKG.lock_po — SELECT ... FOR UPDATE
     * 对应 PL/SQL: select * into v_po from t_purchase_order where po_id = p_po_id for update
     */
    @Select("SELECT * FROM t_purchase_order WHERE po_id = #{poId} FOR UPDATE")
    PurchaseOrder selectForUpdate(@Param("poId") Long poId);

    /**
     * 翻译自 PROCUREMENT_PKG — 更新 PO 状态
     * 对应 PL/SQL: update t_purchase_order set status = p_status where po_id = p_po_id
     */
    @Update("UPDATE t_purchase_order SET status = #{status} WHERE po_id = #{poId}")
    int updateStatus(@Param("poId") Long poId, @Param("status") String status);

    /**
     * 翻译自 PROCUREMENT_PKG.refresh_po_header_status
     * 对应 PL/SQL: 根据行状态汇总更新 PO 头状态
     */
    void refreshPoHeaderStatus(@Param("poId") Long poId);

    /**
     * 翻译自 PROCUREMENT_PKG.create_po_from_mrp
     * 对应 PL/SQL: 按 MRP 计划单的净需求生成 PO
     */
    int createPoFromMrp(@Param("runId") Long runId, @Param("bizDate") LocalDate bizDate);

    /**
     * 翻译自 PROCUREMENT_PKG.reorder_scan
     * 对应 PL/SQL: 补货扫描 - 对低于再订购点的物料自动建 PO
     */
    int reorderScan(@Param("warehouseId") Long warehouseId, @Param("bizDate") LocalDate bizDate);

    List<PoVO> supplierRanking(@Param("fromDate") LocalDate fromDate,
                               @Param("toDate") LocalDate toDate);
}
