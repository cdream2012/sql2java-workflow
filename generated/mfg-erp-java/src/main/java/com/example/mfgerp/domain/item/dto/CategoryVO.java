package com.example.mfgerp.domain.item.dto;

import lombok.Data;

/**
 * Category tree node value object for category path/subtree queries.
 */
@Data
public class CategoryVO {

    private Long categoryId;
    private Long parentCategoryId;
    private String categoryCode;
    private String categoryName;
    private Integer levelNo;
    private String path;
    private Boolean isLeaf;
    private String abcClass;
}
