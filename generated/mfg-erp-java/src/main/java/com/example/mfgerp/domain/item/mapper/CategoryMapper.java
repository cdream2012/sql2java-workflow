package com.example.mfgerp.domain.item.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.domain.item.entity.ItemCategory;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface CategoryMapper extends BaseMapper<ItemCategory> {
}
