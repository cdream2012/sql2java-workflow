package com.example.mfgerp.domain.mrp.service;

import com.example.mfgerp.domain.mrp.dto.PlanVO;

import java.time.LocalDate;
import java.util.List;

/**
 * Translated from MRP_PKG.
 */
public interface MrpService {

    void computeLowLevelCodes();

    Long runMrp(LocalDate runDate, int horizonDays);

    List<PlanVO> nettingDetail(Long runId, Long itemId);

    int releasePlannedOrders(Long runId);
}
