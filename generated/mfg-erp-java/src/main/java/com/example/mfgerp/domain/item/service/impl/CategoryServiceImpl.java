package com.example.mfgerp.domain.item.service.impl;

import com.example.mfgerp.domain.item.dto.CategoryVO;
import com.example.mfgerp.domain.item.mapper.CategoryMapper;
import com.example.mfgerp.domain.item.mapper.ItemMapper;
import com.example.mfgerp.domain.item.service.CategoryService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

/**
 * 翻译自 ITEM_PKG 分类树操作
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class CategoryServiceImpl implements CategoryService {

    private final CategoryMapper categoryMapper;
    private final ItemMapper itemMapper;

    @Override
    public String getCategoryPath(Long categoryId) {
        return itemMapper.getCategoryPath(categoryId);
    }

    @Override
    public List<CategoryVO> listCategorySubtree(Long rootCategoryId) {
        return itemMapper.listCategorySubtree(rootCategoryId);
    }

    @Override
    @Transactional
    public void rebuildCategoryTree() {
        itemMapper.rebuildCategoryTree();
    }
}
