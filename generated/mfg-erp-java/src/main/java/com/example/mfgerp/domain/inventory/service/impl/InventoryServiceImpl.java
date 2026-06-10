package com.example.mfgerp.domain.inventory.service.impl;

import com.example.mfgerp.constant.AppConstants;
import com.example.mfgerp.domain.inventory.dto.AllocationVO;
import com.example.mfgerp.domain.inventory.dto.ReceiveLineDTO;
import com.example.mfgerp.domain.inventory.entity.InventoryBalance;
import com.example.mfgerp.domain.inventory.entity.InventoryLot;
import com.example.mfgerp.domain.inventory.entity.InventoryTxn;
import com.example.mfgerp.domain.inventory.mapper.InventoryBalanceMapper;
import com.example.mfgerp.domain.inventory.mapper.InventoryLotMapper;
import com.example.mfgerp.domain.inventory.mapper.InventoryTxnMapper;
import com.example.mfgerp.domain.inventory.mapper.WarehouseMapper;
import com.example.mfgerp.domain.inventory.service.InventoryService;
import com.example.mfgerp.domain.item.entity.Item;
import com.example.mfgerp.domain.item.mapper.ItemMapper;
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
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * 翻译自 INVENTORY_PKG
 * 三层落地: 流水(append-only) → 批次(FIFO排队明细) → 余额(物料+仓库快照)
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class InventoryServiceImpl implements InventoryService {

    private final InventoryLotMapper lotMapper;
    private final InventoryBalanceMapper balanceMapper;
    private final InventoryTxnMapper txnMapper;
    private final WarehouseMapper warehouseMapper;
    private final ItemMapper itemMapper;
    private final BizDateService bizDateService;
    private final ErrorLogService errorLogService;

    // ─── 私有方法 ────────────────────────────────────────────────

    /**
     * 翻译自 INVENTORY_PKG.post_txn
     * 写一条库存流水，返回 txn_id
     */
    private Long postTxn(Long itemId, Long warehouseId, Long lotId,
                         String txnType, String direction, BigDecimal qty,
                         BigDecimal unitCost, BigDecimal qtyBefore, BigDecimal qtyAfter,
                         String refDocType, Long refDocId, String remark) {
        InventoryTxn txn = new InventoryTxn();
        // 对应 PL/SQL: v_txn_id := seq_inv_txn_id.nextval
        // MyBatis-Plus ASSIGN_ID 自动生成
        // 对应 PL/SQL: util_pkg.gen_doc_no('IT', v_txn_id, util_pkg.curr_biz_date())
        txn.setTxnNo(DocNoGenerator.generate("IT", System.nanoTime(), bizDateService.currBizDate()));
        txn.setItemId(itemId);
        txn.setWarehouseId(warehouseId);
        txn.setLotId(lotId);
        txn.setTxnType(txnType);
        txn.setDirection(direction);
        txn.setQuantity(qty);
        txn.setUnitCost(unitCost);
        // 对应 PL/SQL: round(p_qty * nvl(p_unit_cost, 0), 4)
        txn.setTotalCost(qty.multiply(unitCost != null ? unitCost : BigDecimal.ZERO)
                .setScale(4, RoundingMode.HALF_UP));
        txn.setQtyBefore(qtyBefore);
        txn.setQtyAfter(qtyAfter);
        txn.setTxnDate(bizDateService.currBizDate());
        txn.setTxnTime(LocalDateTime.now());
        txn.setRefDocType(refDocType);
        txn.setRefDocId(refDocId);
        txn.setOperator("SYSTEM");
        txn.setRemark(remark);

        txnMapper.insert(txn);
        return txn.getTxnId();
    }

    /**
     * 翻译自 INVENTORY_PKG.upsert_balance
     * 余额行 MERGE。入库带成本时按移动加权重算 avg_cost
     */
    private void upsertBalance(Long itemId, Long warehouseId, BigDecimal deltaQty,
                                BigDecimal inQty, BigDecimal inCost) {
        // 对应 PL/SQL: merge into t_inventory_balance ...
        // 先查余额行
        InventoryBalance bal = balanceMapper.selectByItemAndWarehouse(itemId, warehouseId);

        if (bal != null) {
            // WHEN MATCHED: 更新
            BigDecimal newQtyOnHand = bal.getQtyOnHand().add(deltaQty);
            // 对应 PL/SQL: avg_cost = case when p_in_cost is not null and (qty_on_hand + in_qty) > 0
            //   then round((qty_on_hand * avg_cost + in_qty * in_cost) / (qty_on_hand + in_qty), 6)
            if (inCost != null && bal.getQtyOnHand().add(inQty).compareTo(BigDecimal.ZERO) > 0) {
                BigDecimal newAvgCost = bal.getQtyOnHand().multiply(bal.getAvgCost())
                        .add(inQty.multiply(inCost))
                        .divide(bal.getQtyOnHand().add(inQty), 6, RoundingMode.HALF_UP);
                bal.setAvgCost(newAvgCost);
            }
            bal.setQtyOnHand(newQtyOnHand);
            bal.setLastTxnDate(bizDateService.currBizDate());
            bal.setVersion(bal.getVersion().add(BigDecimal.ONE));
            bal.setUpdatedAt(LocalDateTime.now());
            balanceMapper.updateById(bal);
        } else {
            // WHEN NOT MATCHED: 插入
            bal = new InventoryBalance();
            bal.setItemId(itemId);
            bal.setWarehouseId(warehouseId);
            bal.setQtyOnHand(deltaQty);
            bal.setQtyAllocated(BigDecimal.ZERO);
            bal.setAvgCost(inCost != null ? inCost : BigDecimal.ZERO);
            bal.setLastTxnDate(bizDateService.currBizDate());
            bal.setVersion(BigDecimal.ZERO);
            bal.setUpdatedAt(LocalDateTime.now());
            balanceMapper.insert(bal);
        }
    }

    // ─── 公开方法 ────────────────────────────────────────────────

    /**
     * 翻译自 INVENTORY_PKG.receive_stock (按 ID)
     * 新建批次 + 写流水 + merge 余额
     */
    @Override
    @Transactional
    public void receiveStock(Long itemId, Long warehouseId, BigDecimal qty, BigDecimal unitCost,
                              String lotNo, String refDocType, Long refDocId) {
        // 对应 PL/SQL: if p_qty is null or p_qty <= 0 then raise
        if (qty == null || qty.compareTo(BigDecimal.ZERO) <= 0) {
            throw new BusinessException(ErrorCode.STOCK_NEGATIVE,
                    AppConstants.C_MOD_INV, "receiveStock",
                    "收货数量必须 > 0", String.valueOf(itemId));
        }

        // 对应 PL/SQL: select nvl(max(qty_on_hand), 0) into v_qty_before ...
        BigDecimal qtyBefore = balanceMapper.getAvailable(itemId, warehouseId);
        if (qtyBefore == null) qtyBefore = BigDecimal.ZERO;

        // 对应 PL/SQL: v_lot_no := nvl(p_lot_no, gen_doc_no('LOT', ...))
        String effectiveLotNo = lotNo != null ? lotNo
                : DocNoGenerator.generate("LOT", System.nanoTime(), bizDateService.currBizDate());

        // 对应 PL/SQL: insert into t_inventory_lot(...) values(...) returning lot_id into p_lot_id
        InventoryLot lot = new InventoryLot();
        lot.setLotNo(effectiveLotNo);
        lot.setItemId(itemId);
        lot.setWarehouseId(warehouseId);
        lot.setQtyOnHand(qty);
        lot.setQtyAllocated(BigDecimal.ZERO);
        lot.setUnitCost(unitCost != null ? unitCost : BigDecimal.ZERO);
        lot.setCurrencyCode(AppConstants.C_DEFAULT_CURRENCY);
        lot.setReceiptDate(bizDateService.currBizDate());
        lot.setStatus(AppConstants.C_LOT_AVAILABLE);
        lot.setSourceDocType(refDocType);
        lot.setSourceDocId(refDocId);
        lot.setCreatedAt(LocalDateTime.now());
        lotMapper.insert(lot);

        // 对应 PL/SQL: p_txn_id := post_txn(...)
        postTxn(itemId, warehouseId, lot.getLotId(),
                AppConstants.C_TXN_RECV, AppConstants.C_DIR_IN,
                qty, unitCost != null ? unitCost : BigDecimal.ZERO,
                qtyBefore, qtyBefore.add(qty),
                refDocType, refDocId, "收货 lot=" + effectiveLotNo);

        // 对应 PL/SQL: upsert_balance(...)
        upsertBalance(itemId, warehouseId, qty, qty, unitCost != null ? unitCost : BigDecimal.ZERO);
    }

    /**
     * 翻译自 INVENTORY_PKG.receive_stock (按编码)
     * 编码转 id 后委托给 ID 版，缺省单位成本取物料标准成本
     */
    @Override
    @Transactional
    public void receiveStockByCode(String itemCode, String warehouseCode, BigDecimal qty,
                                    BigDecimal unitCost, String lotNo) {
        // 对应 PL/SQL: select item_id, std_cost into v_item_id, v_std_cost
        //                from t_item where item_code = p_item_code
        Item item = itemMapper.getItemByCode(itemCode)
                .orElseThrow(() -> new BusinessException(ErrorCode.ITEM_NOT_FOUND,
                        AppConstants.C_MOD_INV, "receiveStockByCode",
                        "物料编码不存在 " + itemCode, itemCode));

        // 对应 PL/SQL: select warehouse_id into v_wh_id
        //                from t_warehouse where warehouse_code = p_warehouse_code
        Long warehouseId = warehouseMapper.findIdByCode(warehouseCode)
                .orElseThrow(() -> new BusinessException(ErrorCode.BALANCE_NOT_FOUND,
                        AppConstants.C_MOD_INV, "receiveStockByCode",
                        "仓库编码不存在 " + warehouseCode, warehouseCode));

        // 对应 PL/SQL: receive_stock(v_item_id, v_wh_id, p_qty, v_std_cost, ...)
        // 缺省单位成本取物料标准成本（PL/SQL: p_unit_cost => v_std_cost）
        receiveStock(item.getItemId(), warehouseId, qty,
                unitCost != null ? unitCost : item.getStdCost(),
                lotNo, null, null);
    }

    /**
     * 翻译自 INVENTORY_PKG.issue_stock
     * FIFO: 窗口函数算批次累计可用量定位扣减批次
     */
    @Override
    @Transactional
    public List<AllocationVO> issueStock(Long itemId, Long warehouseId, BigDecimal qty,
                                          String refDocType, Long refDocId) {
        // 对应 PL/SQL: if p_qty is null or p_qty <= 0 then raise
        if (qty == null || qty.compareTo(BigDecimal.ZERO) <= 0) {
            throw new BusinessException(ErrorCode.STOCK_NEGATIVE,
                    AppConstants.C_MOD_INV, "issueStock",
                    "发料数量必须 > 0", String.valueOf(itemId));
        }

        // 对应 PL/SQL: v_total_avail := get_available(p_item_id, p_warehouse_id)
        BigDecimal totalAvail = getAvailable(itemId, warehouseId);

        // 对应 PL/SQL: if v_total_avail < p_qty then raise e_stock_insufficient
        if (totalAvail.compareTo(qty) < 0) {
            throw new BusinessException(ErrorCode.STOCK_INSUFFICIENT,
                    AppConstants.C_MOD_INV, "issueStock",
                    "可用量不足 avail=" + totalAvail + " need=" + qty,
                    itemId + "/" + warehouseId);
        }

        // 对应 PL/SQL: cursor cur_fifo ... FOR UPDATE
        List<InventoryLot> fifoLots = lotMapper.selectFifoAvailableLots(itemId, warehouseId);

        List<AllocationVO> allocations = new ArrayList<>();
        BigDecimal remaining = qty;
        BigDecimal qtyRun = totalAvail;

        // 对应 PL/SQL: for r in cur_fifo loop ... exit when v_remaining <= 0
        for (InventoryLot lot : fifoLots) {
            if (remaining.compareTo(BigDecimal.ZERO) <= 0) break;

            BigDecimal avail = lot.getQtyOnHand().subtract(
                    lot.getQtyAllocated() != null ? lot.getQtyAllocated() : BigDecimal.ZERO);
            // 对应 PL/SQL: v_take := least(r.avail, v_remaining)
            BigDecimal take = avail.min(remaining);

            // 对应 PL/SQL: update t_inventory_lot set qty_on_hand = qty_on_hand - v_take ...
            lot.setQtyOnHand(lot.getQtyOnHand().subtract(take));
            if (lot.getQtyOnHand().compareTo(BigDecimal.ZERO) == 0) {
                lot.setStatus(AppConstants.C_LOT_CONSUMED);
            }
            lotMapper.updateById(lot);

            AllocationVO alloc = new AllocationVO();
            alloc.setLotId(lot.getLotId());
            alloc.setLotNo(lot.getLotNo());
            alloc.setAllocQty(take);
            alloc.setUnitCost(lot.getUnitCost());
            allocations.add(alloc);

            qtyRun = qtyRun.subtract(take);

            // 对应 PL/SQL: post_txn(ISSUE, OUT, ...)
            postTxn(itemId, warehouseId, lot.getLotId(),
                    AppConstants.C_TXN_ISSUE, AppConstants.C_DIR_OUT,
                    take, lot.getUnitCost(),
                    qtyRun.add(take), qtyRun,
                    refDocType, refDocId, "FIFO 发料 lot=" + lot.getLotNo());

            remaining = remaining.subtract(take);
        }

        // 对应 PL/SQL: upsert_balance(p_item_id, p_warehouse_id, -p_qty)
        upsertBalance(itemId, warehouseId, qty.negate(), BigDecimal.ZERO, null);

        return allocations;
    }

    /**
     * 翻译自 INVENTORY_PKG.bulk_receive
     * FORALL SAVE EXCEPTIONS → Java try-catch 逐行处理
     */
    @Override
    @Transactional
    public int[] bulkReceive(List<ReceiveLineDTO> lines) {
        int okCount = 0;
        int failCount = 0;

        if (lines == null || lines.isEmpty()) {
            return new int[]{0, 0};
        }

        // 对应 PL/SQL: forall i in ... save exceptions
        // Java 中逐行 try-catch 替代 FORALL SAVE EXCEPTIONS
        for (ReceiveLineDTO line : lines) {
            try {
                receiveStock(line.getItemId(), line.getWarehouseId(),
                        line.getQty(), line.getUnitCost(),
                        line.getLotNo(), line.getRefDocType(), line.getRefDocId());
                okCount++;
            } catch (Exception e) {
                failCount++;
                // 对应 PL/SQL: exc_pkg.log_error(...)
                errorLogService.logError(
                        AppConstants.C_ERR_STOCK_NEGATIVE, AppConstants.C_MOD_INV, "bulkReceive",
                        "批量收货行失败: " + e.getMessage(),
                        String.valueOf(line.getItemId()), null, "WARN");
            }
        }

        // 对应 PL/SQL: exc_pkg.log_error(..., 'INFO')
        errorLogService.logError("I3001", AppConstants.C_MOD_INV, "bulkReceive",
                "批量收货 total=" + lines.size() + " ok=" + okCount + " fail=" + failCount,
                null, null, "INFO");

        return new int[]{okCount, failCount};
    }

    /**
     * 翻译自 INVENTORY_PKG.adjust_stock
     * 库存调整(盘盈盘亏)，差异写 ADJ 流水
     */
    @Override
    @Transactional
    public void adjustStock(Long itemId, Long warehouseId, BigDecimal newQty, String reason) {
        if (newQty == null || newQty.compareTo(BigDecimal.ZERO) < 0) {
            throw new BusinessException(ErrorCode.STOCK_NEGATIVE,
                    AppConstants.C_MOD_INV, "adjustStock",
                    "盘点数量不能为负", String.valueOf(itemId));
        }

        BigDecimal curQty = getAvailable(itemId, warehouseId);
        BigDecimal diff = newQty.subtract(curQty);

        if (diff.compareTo(BigDecimal.ZERO) == 0) return;

        LocalDate today = bizDateService.currBizDate();

        if (diff.compareTo(BigDecimal.ZERO) > 0) {
            // 对应 PL/SQL: 盘盈 — 新建盈余批次承接，成本沿用当前均价
            BigDecimal avgCost = BigDecimal.ZERO;
            InventoryBalance bal = balanceMapper.selectByItemAndWarehouse(itemId, warehouseId);
            if (bal != null && bal.getAvgCost() != null) {
                avgCost = bal.getAvgCost();
            }

            // 对应 PL/SQL: receive_stock(..., p_unit_cost => v_avg_cost, ..., p_ref_doc_type => c_txn_adj, ...)
            receiveStock(itemId, warehouseId, diff, avgCost,
                    null, AppConstants.C_TXN_ADJ, null);

            // 对应 PL/SQL: update t_inventory_txn set txn_type = c_txn_adj, remark = '盘盈 ' || p_reason
            //               where txn_id = v_dummy
            // 把 RECV 流水改记成 ADJ 口径(同事务, 语义更准)
            txnMapper.updateTxnTypeByCriteria(itemId, warehouseId,
                    AppConstants.C_TXN_RECV, AppConstants.C_TXN_ADJ,
                    today, AppConstants.C_TXN_ADJ,
                    "盘盈 " + reason);
        } else {
            // 对应 PL/SQL: 盘亏 — 走 FIFO 扣减，流水类型记 ADJ
            issueStock(itemId, warehouseId, diff.negate(),
                    AppConstants.C_TXN_ADJ, null);

            // 对应 PL/SQL: update t_inventory_txn set txn_type = c_txn_adj, remark = '盘亏 ' || p_reason
            //               where item_id = ... and txn_type = c_txn_issue
            //               and txn_date = curr_biz_date() and ref_doc_type = c_txn_adj
            txnMapper.updateTxnTypeByCriteria(itemId, warehouseId,
                    AppConstants.C_TXN_ISSUE, AppConstants.C_TXN_ADJ,
                    today, AppConstants.C_TXN_ADJ,
                    "盘亏 " + reason);
        }

        syncBalance(itemId, warehouseId);
    }

    /**
     * 翻译自 INVENTORY_PKG.transfer_stock
     * 仓间调拨: 出库 + 入库同一事务
     * 出库流水 ISSUE → XFER_OUT，入库流水 RECV → XFER_IN
     */
    @Override
    @Transactional
    public void transferStock(Long itemId, Long fromWh, Long toWh, BigDecimal qty) {
        if (fromWh.equals(toWh)) {
            throw new BusinessException(ErrorCode.BALANCE_NOT_FOUND,
                    AppConstants.C_MOD_INV, "transferStock",
                    "调出调入仓库不能相同", String.valueOf(fromWh));
        }
        if (qty == null || qty.compareTo(BigDecimal.ZERO) <= 0) {
            throw new BusinessException(ErrorCode.STOCK_NEGATIVE,
                    AppConstants.C_MOD_INV, "transferStock",
                    "调拨数量必须 > 0", String.valueOf(itemId));
        }

        LocalDate today = bizDateService.currBizDate();

        // 对应 PL/SQL: issue_stock(p_item_id, p_from_wh, p_qty, C_TXN_XFER_OUT, p_to_wh, v_alloc)
        List<AllocationVO> allocs = issueStock(itemId, fromWh, qty, AppConstants.C_TXN_XFER_OUT, toWh);

        // 对应 PL/SQL: 把出库流水类型从 ISSUE 改记 XFER_OUT(同事务)
        // update t_inventory_txn set txn_type = c_txn_xfer_out
        //   where item_id = ... and warehouse_id = p_from_wh
        //   and txn_type = c_txn_issue and txn_date = curr_biz_date()
        //   and ref_doc_type = c_txn_xfer_out and ref_doc_id = p_to_wh
        txnMapper.updateTxnTypeByCriteria(itemId, fromWh,
                AppConstants.C_TXN_ISSUE, AppConstants.C_TXN_XFER_OUT,
                today, AppConstants.C_TXN_XFER_OUT,
                null);

        // 计算加权成本
        BigDecimal totalCost = BigDecimal.ZERO;
        for (AllocationVO alloc : allocs) {
            totalCost = totalCost.add(alloc.getAllocQty().multiply(alloc.getUnitCost()));
        }
        BigDecimal xferCost = totalCost.divide(qty, 6, RoundingMode.HALF_UP);

        // 对应 PL/SQL: receive_stock(..., p_unit_cost => v_xfer_cost, ..., p_ref_doc_type => c_txn_xfer_in, ...)
        receiveStock(itemId, toWh, qty, xferCost, null, AppConstants.C_TXN_XFER_IN, fromWh);

        // 对应 PL/SQL: 把入库流水类型从 RECV 改记 XFER_IN(同事务)
        // update t_inventory_txn set txn_type = c_txn_xfer_in where txn_id = v_dummy
        txnMapper.updateTxnTypeByCriteria(itemId, toWh,
                AppConstants.C_TXN_RECV, AppConstants.C_TXN_XFER_IN,
                today, AppConstants.C_TXN_XFER_IN,
                null);
    }

    /**
     * 翻译自 INVENTORY_PKG.sync_balance
     * 按批次实时重算并 merge 余额行
     */
    @Override
    @Transactional
    public void syncBalance(Long itemId, Long warehouseId) {
        // 对应 PL/SQL: select nvl(sum(qty_on_hand), 0), nvl(sum(qty_allocated), 0), ...
        //   from t_inventory_lot where item_id = p_item_id and warehouse_id = p_warehouse_id
        //   and status in (C_LOT_AVAILABLE, C_LOT_QUARANTINE)
        balanceMapper.syncBalanceFromLots(itemId, warehouseId, bizDateService.currBizDate());
    }

    /**
     * 翻译自 INVENTORY_PKG.get_available
     */
    @Override
    public BigDecimal getAvailable(Long itemId, Long warehouseId) {
        BigDecimal avail = balanceMapper.getAvailable(itemId, warehouseId);
        return avail != null ? avail : BigDecimal.ZERO;
    }

    /**
     * 翻译自 INVENTORY_PKG.archive_txns_before
     * 对应 PL/SQL: EXECUTE IMMEDIATE 动态建表/搬数/清理
     */
    @Override
    @Transactional
    public int archiveTxnsBefore(LocalDate beforeDate) {
        // 对应 PL/SQL: v_tab := 't_inv_txn_arch_' || to_char(p_before_date, 'YYYYMM')
        String archiveTable = "t_inv_txn_arch_" + beforeDate.format(
                java.time.format.DateTimeFormatter.ofPattern("yyyyMM"));

        try {
            // 对应 PL/SQL: create table ... as select * from t_inventory_txn where 1 = 0
            txnMapper.createArchiveTable(archiveTable);

            // 对应 PL/SQL: insert into archive select * from t_inventory_txn where txn_date < :1
            int archived = txnMapper.archiveToTable(archiveTable, beforeDate);

            // 对应 PL/SQL: delete from t_inventory_txn where txn_date < :1
            txnMapper.deleteArchived(beforeDate);

            errorLogService.logError("I3090", AppConstants.C_MOD_INV, "archiveTxnsBefore",
                    "流水归档 tab=" + archiveTable + " before=" + beforeDate + " rows=" + archived,
                    archiveTable, null, "INFO");

            return archived;
        } catch (Exception e) {
            errorLogService.logError(AppConstants.C_ERR_SYSTEM, AppConstants.C_MOD_INV,
                    "archiveTxnsBefore", "归档失败 tab=" + archiveTable + ": " + e.getMessage(),
                    archiveTable, null, "ERROR");
            throw e;
        }
    }
}
