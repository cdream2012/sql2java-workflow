package com.example.mfgerp.domain.item.service;

import com.example.mfgerp.domain.item.dto.CategoryVO;
import com.example.mfgerp.domain.item.dto.DimensionVO;
import com.example.mfgerp.domain.item.dto.ItemVO;
import com.example.mfgerp.domain.item.entity.Item;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

/**
 * Translated from ITEM_PKG.
 */
public interface ItemService {

    Optional<ItemVO> getItemObj(Long itemId);

    Optional<Item> getItem(Long itemId);

    Optional<Long> findItemId(String itemCode);

    Long createItem(String itemCode, String itemName, String itemType, Long categoryId,
                    String baseUom, BigDecimal stdCost, DimensionVO dim, List<String> tags);

    String getCategoryPath(Long categoryId);

    List<CategoryVO> listCategorySubtree(Long rootCategoryId);

    void rebuildCategoryTree();

    void reclassifyAbc(LocalDate fromDate, LocalDate toDate);

    void applyItemFlat(Long itemId, String itemName, BigDecimal stdCost,
                       BigDecimal listPrice, String status,
                       BigDecimal lengthCm, BigDecimal widthCm,
                       BigDecimal heightCm, BigDecimal weightKg);
}
