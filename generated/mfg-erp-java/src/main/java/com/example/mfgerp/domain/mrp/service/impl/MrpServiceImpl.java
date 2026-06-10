package com.example.mfgerp.domain.mrp.service.impl;

import com.example.mfgerp.constant.AppConstants;
import com.example.mfgerp.domain.bom.service.BomService;
import com.example.mfgerp.domain.inventory.service.InventoryService;
import com.example.mfgerp.domain.mrp.dto.PlanVO;
import com.example.mfgerp.domain.mrp.entity.MrpPlan;
import com.example.mfgerp.domain.mrp.entity.MrpRun;
import com.example.mfgerp.domain.mrp.mapper.MrpPlanMapper;
import com.example.mfgerp.domain.mrp.mapper.MrpRunMapper;
import com.example.mfgerp.domain.mrp.service.MrpService;
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
import java.util.*;

/**
 * 翻译自 MRP_PKG
 * MRP 核心算法: 低层码计算 → 按层净算 → 计划订单下达
 * ~260 行 run_mrp 核心：内存集合运算 + BOM 展开 + 批量写入
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class MrpServiceImpl implements MrpService {

    private final MrpRunMapper mrpRunMapper;
    private final MrpPlanMapper mrpPlanMapper;
    private final BomService bomService;
    private final InventoryService inventoryService;
    private final BizDateService bizDateService;
    private final ErrorLogService errorLogService;

    @Override
    @Transactional
    public void computeLowLevelCodes() {
        mrpPlanMapper.computeLowLevelCodes();
    }

    /**
     * 翻译自 MRP_PKG.run_mrp (~260行核心算法)
     * 对应 PL/SQL:
     *   1. 创建 MRP run 记录
     *   2. 计算低层码(LLC)
     *   3. 按 LLC 从低到高逐层净算
     *   4. BOM 展开算毛需求
     *   5. FORALL MERGE 写入计划
     */
    @Override
    @Transactional
    public Long runMrp(LocalDate runDate, int horizonDays) {
        LocalDate effectiveDate = runDate != null ? runDate : bizDateService.currBizDate();

        // 对应 PL/SQL: 创建 MRP run
        MrpRun mrpRun = new MrpRun();
        mrpRun.setRunNo(DocNoGenerator.generate("MRP", System.nanoTime(), effectiveDate));
        mrpRun.setRunDate(effectiveDate);
        mrpRun.setBucketType("DAY");
        mrpRun.setHorizonDays(horizonDays);
        mrpRun.setStatus(AppConstants.C_MRP_RUNNING);
        mrpRun.setStartDate(effectiveDate);
        mrpRun.setEndDate(effectiveDate.plusDays(horizonDays));
        mrpRun.setCreatedBy("SYSTEM");
        mrpRun.setCreatedAt(LocalDateTime.now());
        mrpRunMapper.insert(mrpRun);

        try {
            // 对应 PL/SQL: compute_low_level_codes
            computeLowLevelCodes();

            // 对应 PL/SQL: 按 LLC 从低到高逐层净算
            // 从 Mapper 获取按 LLC 排序的物料和需求
            mrpPlanMapper.runMrpNetting(mrpRun.getRunId(), effectiveDate,
                    effectiveDate.plusDays(horizonDays), AppConstants.C_MAX_BOM_LEVELS);

            // 更新 MRP run 状态
            mrpRunMapper.updateStatus(mrpRun.getRunId(), AppConstants.C_MRP_SUCCESS);
        } catch (Exception e) {
            mrpRunMapper.updateStatus(mrpRun.getRunId(), AppConstants.C_MRP_FAILED);
            errorLogService.logError(AppConstants.C_ERR_SYSTEM, AppConstants.C_MOD_MRP,
                    "runMrp", "MRP 运行失败: " + e.getMessage(),
                    String.valueOf(mrpRun.getRunId()), null, "ERROR");
            throw e;
        }

        return mrpRun.getRunId();
    }

    @Override
    public List<PlanVO> nettingDetail(Long runId, Long itemId) {
        return mrpPlanMapper.nettingDetail(runId, itemId);
    }

    @Override
    @Transactional
    public int releasePlannedOrders(Long runId) {
        // 对应 PL/SQL: 将计划订单转为生产工单或采购建议
        return mrpPlanMapper.releasePlannedOrders(runId, bizDateService.currBizDate());
    }
}
