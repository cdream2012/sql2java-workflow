package com.example.mfgerp.domain.procurement.service.impl;

import com.example.mfgerp.constant.AppConstants;
import com.example.mfgerp.domain.inventory.service.InventoryService;
import com.example.mfgerp.domain.procurement.dto.PoVO;
import com.example.mfgerp.domain.procurement.entity.PurchaseOrder;
import com.example.mfgerp.domain.procurement.entity.PoLine;
import com.example.mfgerp.domain.procurement.mapper.PoLineMapper;
import com.example.mfgerp.domain.procurement.mapper.PurchaseOrderMapper;
import com.example.mfgerp.domain.procurement.service.PurchaseOrderService;
import com.example.mfgerp.infrastructure.exception.BusinessException;
import com.example.mfgerp.infrastructure.exception.ErrorCode;
import com.example.mfgerp.infrastructure.exception.ErrorLogService;
import com.example.mfgerp.infrastructure.util.BizDateService;
import com.example.mfgerp.infrastructure.util.DocNoGenerator;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;

/**
 * 翻译自 PROCUREMENT_PKG
 * 采购订单生命周期管理: 创建/加行/审批/收货/从MRP转PO/补货扫描/供应商排名/取消
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PurchaseOrderServiceImpl implements PurchaseOrderService {

    private final PurchaseOrderMapper purchaseOrderMapper;
    private final PoLineMapper poLineMapper;
    private final InventoryService inventoryService;
    private final BizDateService bizDateService;
    private final ErrorLogService errorLogService;

    @Override
    @Transactional
    public Long createPo(Long supplierId, Long warehouseId, LocalDate expectedDate) {
        // 对应 PL/SQL: insert into t_purchase_order(...) values(...)
        PurchaseOrder po = new PurchaseOrder();
        po.setPoNo(DocNoGenerator.generate("PO", System.nanoTime(), bizDateService.currBizDate()));
        po.setSupplierId(supplierId);
        po.setWarehouseId(warehouseId);
        po.setOrderDate(bizDateService.currBizDate());
        po.setExpectedDate(expectedDate);
        po.setStatus(AppConstants.C_PO_DRAFT);
        po.setTotalAmount(BigDecimal.ZERO);
        po.setCreatedBy("SYSTEM");
        po.setCreatedAt(LocalDateTime.now());
        purchaseOrderMapper.insert(po);
        return po.getPoId();
    }

    @Override
    @Transactional
    public void addPoLine(Long poId, Long itemId, BigDecimal qty, BigDecimal unitPrice,
                           String uom, LocalDate needDate) {
        // 对应 PL/SQL: lock_po + insert into t_po_line(...)
        PurchaseOrder po = purchaseOrderMapper.selectForUpdate(poId);
        if (!AppConstants.C_PO_DRAFT.equals(po.getStatus())) {
            throw new BusinessException(ErrorCode.PO_STATUS_INVALID,
                    AppConstants.C_MOD_PROCURE, "addPoLine",
                    "PO 状态不允许加行 status=" + po.getStatus(), String.valueOf(poId));
        }

        // 对应 PL/SQL: 取当前最大行号+1
        BigDecimal maxLineNo = poLineMapper.selectMaxLineNo(poId);
        BigDecimal nextLineNo = maxLineNo != null ? maxLineNo.add(BigDecimal.ONE) : BigDecimal.ONE;

        PoLine line = new PoLine();
        line.setPoId(poId);
        line.setLineNo(nextLineNo);
        line.setItemId(itemId);
        line.setQtyOrdered(qty);
        line.setUnitPrice(unitPrice);
        line.setUom(uom);
        line.setNeedDate(needDate);
        line.setQtyReceived(BigDecimal.ZERO);
        line.setLineStatus(AppConstants.C_LINE_OPEN);
        poLineMapper.insert(line);

        // 对应 PL/SQL: refresh_po_header_status
        refreshPoHeaderStatus(poId);
    }

    @Override
    @Transactional
    public void approvePo(Long poId) {
        PurchaseOrder po = purchaseOrderMapper.selectForUpdate(poId);
        if (!AppConstants.C_PO_DRAFT.equals(po.getStatus())) {
            throw new BusinessException(ErrorCode.PO_STATUS_INVALID,
                    AppConstants.C_MOD_PROCURE, "approvePo",
                    "PO 状态不允许审批 status=" + po.getStatus(), String.valueOf(poId));
        }
        purchaseOrderMapper.updateStatus(poId, AppConstants.C_PO_APPROVED);
    }

    @Override
    @Transactional
    public void receivePoLine(Long poId, BigDecimal lineNo, BigDecimal qty, BigDecimal unitCost) {
        PurchaseOrder po = purchaseOrderMapper.selectForUpdate(poId);
        PoLine line = poLineMapper.selectForUpdate(poId, lineNo);

        // 对应 PL/SQL: 校验状态和数量
        if (!AppConstants.C_LINE_OPEN.equals(line.getLineStatus())
                && !AppConstants.C_LINE_PARTIAL.equals(line.getLineStatus())) {
            throw new BusinessException(ErrorCode.PO_STATUS_INVALID,
                    AppConstants.C_MOD_PROCURE, "receivePoLine",
                    "行状态不允许收货行 status=" + line.getLineStatus(), String.valueOf(poId));
        }

        BigDecimal newReceived = line.getQtyReceived().add(qty);
        if (newReceived.compareTo(line.getQtyOrdered()) > 0) {
            throw new BusinessException(ErrorCode.PO_OVER_RECEIPT,
                    AppConstants.C_MOD_PROCURE, "receivePoLine",
                    "收货超量 ordered=" + line.getQtyOrdered() + " received=" + newReceived,
                    String.valueOf(poId));
        }

        // 对应 PL/SQL: inventory_pkg.receive_stock
        inventoryService.receiveStock(line.getItemId(), po.getWarehouseId(),
                qty, unitCost != null ? unitCost : line.getUnitPrice(),
                null, AppConstants.C_TXN_RECV, line.getPoLineId());

        // 对应 PL/SQL: update t_po_line set qty_received = ...
        line.setQtyReceived(newReceived);
        if (newReceived.compareTo(line.getQtyOrdered()) >= 0) {
            line.setLineStatus(AppConstants.C_LINE_CLOSED);
        } else {
            line.setLineStatus(AppConstants.C_LINE_PARTIAL);
        }
        poLineMapper.updateById(line);

        refreshPoHeaderStatus(poId);
    }

    @Override
    @Transactional
    public int createPoFromMrp(Long runId) {
        // 对应 PL/SQL: 按 MRP 计划单的净需求生成 PO
        // 委托 Mapper SQL 完成聚合和插入
        int count = purchaseOrderMapper.createPoFromMrp(runId, bizDateService.currBizDate());
        return count;
    }

    @Override
    @Transactional
    public int reorderScan(Long warehouseId) {
        // 对应 PL/SQL: 补货扫描 - 对低于再订购点的物料自动建 PO
        return purchaseOrderMapper.reorderScan(warehouseId, bizDateService.currBizDate());
    }

    @Override
    public List<PoVO> supplierRanking(LocalDate fromDate, LocalDate toDate) {
        return purchaseOrderMapper.supplierRanking(fromDate, toDate);
    }

    @Override
    @Transactional
    public void cancelPo(Long poId, String reason) {
        PurchaseOrder po = purchaseOrderMapper.selectForUpdate(poId);
        if (AppConstants.C_PO_RECEIVED.equals(po.getStatus())
                || AppConstants.C_PO_CLOSED.equals(po.getStatus())) {
            throw new BusinessException(ErrorCode.PO_STATUS_INVALID,
                    AppConstants.C_MOD_PROCURE, "cancelPo",
                    "PO 已收货或关闭，不可取消", String.valueOf(poId));
        }
        purchaseOrderMapper.updateStatus(poId, AppConstants.C_PO_CANCELLED);
    }

    /**
     * 翻译自 PROCUREMENT_PKG.refresh_po_header_status
     * 对应 PL/SQL: 根据行状态汇总更新 PO 头状态
     */
    private void refreshPoHeaderStatus(Long poId) {
        purchaseOrderMapper.refreshPoHeaderStatus(poId);
    }
}
