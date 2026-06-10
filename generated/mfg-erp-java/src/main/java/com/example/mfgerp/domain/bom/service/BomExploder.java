package com.example.mfgerp.domain.bom.service;

import com.example.mfgerp.domain.bom.dto.ExplosionRowVO;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

/**
 * Translated from BOM_PKG.explode (PIPELINED + CONNECT BY).
 * Dedicated interface for the BOM explosion algorithm.
 */
public interface BomExploder {

    List<ExplosionRowVO> explode(Long itemId, BigDecimal qty, LocalDate asOf);
}
