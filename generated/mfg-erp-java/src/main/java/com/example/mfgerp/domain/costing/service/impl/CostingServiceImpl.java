package com.example.mfgerp.domain.costing.service.impl;

import com.example.mfgerp.constant.AppConstants;
import com.example.mfgerp.domain.bom.service.CostRollupService;
import com.example.mfgerp.domain.costing.dto.FifoLayerVO;
import com.example.mfgerp.domain.costing.dto.LandedCostVO;
import com.example.mfgerp.domain.costing.mapper.CostingMapper;
import com.example.mfgerp.domain.costing.service.CostingService;
import com.example.mfgerp.domain.item.mapper.ItemMapper;
import com.example.mfgerp.infrastructure.exception.ErrorLogService;
import com.example.mfgerp.infrastructure.util.BizDateService;
import com.example.mfgerp.infrastructure.util.SysParamService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.List;

/**
 * 翻译自 COSTING_PKG
 * 成本计算: FIFO分层、库存估值、移动加权平均、落地成本、标准成本卷算
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class CostingServiceImpl implements CostingService {

    private final CostingMapper costingMapper;
    private final CostRollupService costRollupService;
    private final ItemMapper itemMapper;
    private final BizDateService bizDateService;
    private final SysParamService sysParamService;
    private final ErrorLogService errorLogService;

    @Override
    public List<FifoLayerVO> fifoLayers(Long itemId, Long warehouseId) {
        return costingMapper.fifoLayers(itemId, warehouseId);
    }

    @Override
    public List<FifoLayerVO> inventoryValue(Long warehouseId) {
        return costingMapper.inventoryValue(warehouseId);
    }

    /**
     * 翻译自 COSTING_PKG.recompute_avg_cost
     * 对应 PL/SQL: 移动加权平均计算并回写 balance.avg_cost
     */
    @Override
    @Transactional
    public void recomputeAvgCost(Long itemId, Long warehouseId) {
        costingMapper.recomputeAvgCost(itemId, warehouseId);
    }

    @Override
    public List<LandedCostVO> landedCostReport(Long poId) {
        // 对应 PL/SQL: WITH FUNCTION 内联 PL/SQL 分摊函数
        // Java 中用 Mapper SQL 实现，alloc_charge 逻辑改为 SQL 表达式
        BigDecimal freight = sysParamService.getParam("LANDED_FREIGHT", BigDecimal.ZERO);
        BigDecimal duty = sysParamService.getParam("LANDED_DUTY", BigDecimal.ZERO);
        String basis = sysParamService.getParam("LANDED_BASIS", "AMT");
        return costingMapper.landedCostReport(poId, freight, duty, basis);
    }

    /**
     * 翻译自 COSTING_PKG.roll_standard_cost
     * 对应 PL/SQL: 逐料调 bom_pkg.rolled_cost，单料失败不阻断整批
     */
    @Override
    @Transactional
    public void rollStandardCost(LocalDate asOf) {
        LocalDate effectiveDate = asOf != null ? asOf : bizDateService.currBizDate();
        int okCount = 0;
        int failCount = 0;

        // 对应 PL/SQL: for r in (select item_id, item_code from t_item
        //   where item_type in (c_item_fg, c_item_semi) and status = 'ACTIVE') loop
        var items = itemMapper.selectItemsByTypes(
                List.of(AppConstants.C_ITEM_FG, AppConstants.C_ITEM_SEMI));

        for (var item : items) {
            try {
                // 对应 PL/SQL: v_rolled := bom_pkg.rolled_cost(r.item_id, v_as_of)
                BigDecimal rolled = costRollupService.rolledCost(item.getItemId(), effectiveDate);

                // 对应 PL/SQL: merge into t_item t using (...) s on (t.item_id = s.item_id)
                //   when matched then update set std_cost = round(v_rolled, 6)
                costingMapper.updateStdCost(item.getItemId(),
                        rolled.setScale(6, RoundingMode.HALF_UP));

                okCount++;
            } catch (Exception e) {
                // 对应 PL/SQL: when others then log_error(WARN) and continue
                failCount++;
                errorLogService.logError(
                        AppConstants.C_ERR_BOM_NO_ACTIVE, AppConstants.C_MOD_COST,
                        "rollStandardCost",
                        "卷算失败 item=" + item.getItemCode() + " err=" + e.getMessage(),
                        String.valueOf(item.getItemId()), null, "WARN");
            }
        }

        errorLogService.logError("I3010", AppConstants.C_MOD_COST, "rollStandardCost",
                "标准成本卷算完成 as_of=" + effectiveDate + " ok=" + okCount + " fail=" + failCount,
                null, null, "INFO");
    }
}
