package com.example.mfgerp.domain.mrp.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.domain.mrp.dto.PlanVO;
import com.example.mfgerp.domain.mrp.entity.MrpPlan;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.time.LocalDate;
import java.util.List;

@Mapper
public interface MrpPlanMapper extends BaseMapper<MrpPlan> {

    List<PlanVO> nettingDetail(@Param("runId") Long runId, @Param("itemId") Long itemId);

    /**
     * 翻译自 MRP_PKG.compute_low_level_codes
     * 对应 PL/SQL: 计算物料低层码(LLC) — 递归遍历 BOM 确定每层物料编码
     */
    void computeLowLevelCodes();

    /**
     * 翻译自 MRP_PKG.run_mrp 核心净算
     * 对应 PL/SQL: 按 LLC 从低到高逐层净算，BOM 展开算毛需求，FORALL MERGE 写入计划
     */
    void runMrpNetting(@Param("runId") Long runId,
                       @Param("startDate") LocalDate startDate,
                       @Param("endDate") LocalDate endDate,
                       @Param("maxBomLevels") int maxBomLevels);

    /**
     * 翻译自 MRP_PKG.release_planned_orders
     * 对应 PL/SQL: 将计划订单转为生产工单或采购建议
     */
    int releasePlannedOrders(@Param("runId") Long runId, @Param("bizDate") LocalDate bizDate);
}
