package com.example.mfgerp.domain.item.service;

import com.example.mfgerp.domain.item.dto.CategoryVO;

import java.util.List;

/**
 * Translated from ITEM_PKG category-related operations.
 */
public interface CategoryService {

    String getCategoryPath(Long categoryId);

    List<CategoryVO> listCategorySubtree(Long rootCategoryId);

    void rebuildCategoryTree();
}
