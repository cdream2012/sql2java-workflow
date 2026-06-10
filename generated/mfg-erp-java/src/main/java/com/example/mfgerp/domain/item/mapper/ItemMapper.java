package com.example.mfgerp.domain.item.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.domain.item.dto.CategoryVO;
import com.example.mfgerp.domain.item.dto.DimensionVO;
import com.example.mfgerp.domain.item.dto.ItemVO;
import com.example.mfgerp.domain.item.entity.Item;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

@Mapper
public interface ItemMapper extends BaseMapper<Item> {

    Optional<ItemVO> getItemObj(@Param("itemId") Long itemId);

    Optional<Item> getItem(@Param("itemId") Long itemId);

    /**
     * 按物料编码查物料
     * 对应 PL/SQL: select item_id, std_cost into ... from t_item where item_code = p_item_code
     */
    Optional<Item> getItemByCode(@Param("itemCode") String itemCode);

    Optional<Long> findItemId(@Param("itemCode") String itemCode);

    String getCategoryPath(@Param("categoryId") Long categoryId);

    List<CategoryVO> listCategorySubtree(@Param("rootCategoryId") Long rootCategoryId);

    /**
     * 翻译自 ITEM_PKG.rebuild_category_tree 的 MERGE
     */
    void rebuildCategoryTree();

    /**
     * 翻译自 ITEM_PKG.reclassify_abc 的 MERGE
     */
    void reclassifyAbc(@Param("fromDate") LocalDate fromDate,
                       @Param("toDate") LocalDate toDate,
                       @Param("aPct") BigDecimal aPct,
                       @Param("bPct") BigDecimal bPct);

    /**
     * 翻译自 ITEM_PKG.apply_item_flat 的 UPDATE
     */
    int applyItemFlat(@Param("itemId") Long itemId,
                      @Param("itemName") String itemName,
                      @Param("stdCost") BigDecimal stdCost,
                      @Param("listPrice") BigDecimal listPrice,
                      @Param("status") String status,
                      @Param("dim") DimensionVO dim);

    /**
     * 翻译自 COSTING_PKG.roll_standard_cost 的物料查询
     * 对应 PL/SQL: select item_id, item_code from t_item where item_type in (...) and status = 'ACTIVE'
     */
    List<Item> selectItemsByTypes(@Param("types") List<String> types);
}
