package com.example.mfgerp.domain.bom.service;

import com.example.mfgerp.domain.bom.dto.BomComponentVO;
import com.example.mfgerp.domain.bom.dto.ExplosionRowVO;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

/**
 * Translated from BOM_PKG.
 */
public interface BomService {

    List<BomComponentVO> getComponents(Long bomId);

    Long getActiveBomId(Long itemId, LocalDate asOf);

    List<ExplosionRowVO> explode(Long itemId, BigDecimal qty, LocalDate asOf);

    /**
     * 翻译自 BOM_PKG.explode_table
     * 对应 PL/SQL: p_result OUT t_explosion_tab → Java 返回 List
     */
    List<ExplosionRowVO> explodeTable(Long itemId, BigDecimal qty, LocalDate asOf);

    List<ExplosionRowVO> explodeCte(Long itemId, BigDecimal qty);

    List<ExplosionRowVO> whereUsed(Long componentId, Integer maxLevels);

    List<ExplosionRowVO> compareVersions(Long bomIdOld, Long bomIdNew);

    BigDecimal rolledCost(Long itemId, LocalDate asOf);
}
