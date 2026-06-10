package com.example.mfgerp.domain.item.service.impl;

import com.example.mfgerp.constant.AppConstants;
import com.example.mfgerp.domain.item.dto.CategoryVO;
import com.example.mfgerp.domain.item.dto.DimensionVO;
import com.example.mfgerp.domain.item.dto.ItemVO;
import com.example.mfgerp.domain.item.entity.Item;
import com.example.mfgerp.domain.item.mapper.ItemMapper;
import com.example.mfgerp.domain.item.service.ItemService;
import com.example.mfgerp.infrastructure.exception.BusinessException;
import com.example.mfgerp.infrastructure.exception.ErrorCode;
import com.example.mfgerp.infrastructure.util.SysParamService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;

/**
 * 翻译自 ITEM_PKG
 * 物料主数据 + 分类树操作
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ItemServiceImpl implements ItemService {

    private final ItemMapper itemMapper;
    private final SysParamService sysParamService;

    /**
     * 翻译自 ITEM_PKG.get_item_obj
     * 对应 PL/SQL: 按 item_type 多态构造不同子型
     * Java 中用 ItemVO 统一表示，通过 itemType 字段区分
     */
    @Override
    public Optional<ItemVO> getItemObj(Long itemId) {
        // 对应 PL/SQL: v_item := get_item(p_item_id);
        Item item = itemMapper.getItem(itemId)
                .orElseThrow(() -> new BusinessException(ErrorCode.ITEM_NOT_FOUND,
                        AppConstants.C_MOD_ITEM, "getItemObj",
                        "物料不存在 item_id=" + itemId, String.valueOf(itemId)));

        ItemVO vo = new ItemVO();
        vo.setItemId(item.getItemId());
        vo.setItemCode(item.getItemCode());
        vo.setItemName(item.getItemName());
        vo.setItemType(item.getItemType());
        vo.setBaseUom(item.getBaseUom());
        vo.setStdCost(item.getStdCost());
        vo.setListPrice(item.getListPrice());
        vo.setValuationMethod(item.getValuationMethod());
        vo.setDim(item.getDim());
        vo.setCurrencyCode(item.getCurrencyCode());

        // 对应 PL/SQL: case v_item.item_type when c_item_raw then ...
        switch (item.getItemType()) {
            case AppConstants.C_ITEM_RAW:
                // 对应 PL/SQL: t_raw_material_obj (原材料: 供应商、保质期、再订购点)
                vo.setIsStockable(true);
                vo.setReorderPoint(item.getReorderPoint());
                break;
            case AppConstants.C_ITEM_SVC:
                // 对应 PL/SQL: t_service_item_obj (服务类: 不入库不估值)
                vo.setIsStockable(false);
                break;
            default:
                // 对应 PL/SQL: FG / SEMI: 取默认 ACTIVE BOM 头作为对象的 bom_id
                vo.setIsStockable(true);
                vo.setMakeLeadDays(item.getLeadTimeDays());
                break;
        }

        return Optional.of(vo);
    }

    /**
     * 翻译自 ITEM_PKG.get_item
     * 对应 PL/SQL: select * into v_item from t_item where item_id = p_item_id;
     * 找不到抛 e_item_not_found
     */
    @Override
    public Optional<Item> getItem(Long itemId) {
        Optional<Item> item = itemMapper.getItem(itemId);
        if (item.isEmpty()) {
            throw new BusinessException(ErrorCode.ITEM_NOT_FOUND,
                    AppConstants.C_MOD_ITEM, "getItem",
                    "物料不存在 item_id=" + itemId, String.valueOf(itemId));
        }
        return item;
    }

    /**
     * 翻译自 ITEM_PKG.find_item_id
     * 对应 PL/SQL: select item_id into v_id from t_item where item_code = p_item_code;
     * 找不到抛 e_item_not_found
     */
    @Override
    public Optional<Long> findItemId(String itemCode) {
        Optional<Long> id = itemMapper.findItemId(itemCode);
        if (id.isEmpty()) {
            throw new BusinessException(ErrorCode.ITEM_NOT_FOUND,
                    AppConstants.C_MOD_ITEM, "findItemId",
                    "物料编码不存在 code=" + itemCode, itemCode);
        }
        return id;
    }

    /**
     * 翻译自 ITEM_PKG.create_item
     * 对应 PL/SQL:
     *   p_item_id := seq_item_id.nextval;
     *   insert into t_item (...) values (...);
     */
    @Override
    @Transactional
    public Long createItem(String itemCode, String itemName, String itemType, Long categoryId,
                           String baseUom, BigDecimal stdCost, DimensionVO dim, List<String> tags) {
        // 对应 PL/SQL: if p_item_type not in (c_item_raw, c_item_semi, c_item_fg, c_item_svc) then
        List<String> validTypes = Arrays.asList(
                AppConstants.C_ITEM_RAW, AppConstants.C_ITEM_SEMI,
                AppConstants.C_ITEM_FG, AppConstants.C_ITEM_SVC);
        if (!validTypes.contains(itemType)) {
            throw new BusinessException(ErrorCode.ITEM_NOT_FOUND,
                    AppConstants.C_MOD_ITEM, "createItem",
                    "非法物料类型 " + itemType, itemCode);
        }

        // 对应 PL/SQL: case p_item_type when c_item_svc then c_val_none when c_item_raw then c_val_fifo else c_val_std end
        String valuationMethod;
        switch (itemType) {
            case "SVC":
                valuationMethod = AppConstants.C_VAL_NONE;
                break;
            case "RAW":
                valuationMethod = AppConstants.C_VAL_FIFO;
                break;
            default:
                valuationMethod = AppConstants.C_VAL_STD;
                break;
        }

        Item item = new Item();
        item.setItemCode(itemCode);
        item.setItemName(itemName);
        item.setItemType(itemType);
        item.setCategoryId(categoryId);
        item.setBaseUom(baseUom);
        item.setStdCost(stdCost != null ? stdCost : BigDecimal.ZERO);
        item.setValuationMethod(valuationMethod);
        item.setDim(dim);
        item.setTags(tags);
        // 对应 PL/SQL: util_pkg.get_operator()
        item.setCreatedBy("SYSTEM");
        item.setCreatedAt(LocalDateTime.now());

        itemMapper.insert(item);
        return item.getItemId();
    }

    /**
     * 翻译自 ITEM_PKG.get_category_path
     * 对应 PL/SQL: CONNECT BY 路径查询
     * 实际 SQL 在 ItemMapper.xml 中实现（MySQL 用递归 CTE 替代 CONNECT BY）
     */
    @Override
    public String getCategoryPath(Long categoryId) {
        return itemMapper.getCategoryPath(categoryId);
    }

    /**
     * 翻译自 ITEM_PKG.list_category_subtree
     * 对应 PL/SQL: SYS_REFCURSOR OUT → Java List<CategoryVO>
     */
    @Override
    public List<CategoryVO> listCategorySubtree(Long rootCategoryId) {
        return itemMapper.listCategorySubtree(rootCategoryId);
    }

    /**
     * 翻译自 ITEM_PKG.rebuild_category_tree
     * 对应 PL/SQL: MERGE INTO t_item_category tgt USING (CONNECT BY 子查询) src ON (tgt.category_id = src.category_id)
     * 实际 SQL 在 ItemMapper.xml 中实现
     */
    @Override
    @Transactional
    public void rebuildCategoryTree() {
        itemMapper.rebuildCategoryTree();
    }

    /**
     * 翻译自 ITEM_PKG.reclassify_abc
     * 对应 PL/SQL: 窗口函数算累计占比 + MERGE 回写 abc_class
     * 实际 SQL 在 ItemMapper.xml 中实现
     */
    @Override
    @Transactional
    public void reclassifyAbc(LocalDate fromDate, LocalDate toDate) {
        // 对应 PL/SQL: v_a_pct := util_pkg.get_param('ABC_A_PCT', 0.80);
        BigDecimal aPct = sysParamService.getParam("ABC_A_PCT", new BigDecimal("0.80"));
        // 对应 PL/SQL: v_b_pct := util_pkg.get_param('ABC_B_PCT', 0.95);
        BigDecimal bPct = sysParamService.getParam("ABC_B_PCT", new BigDecimal("0.95"));

        itemMapper.reclassifyAbc(fromDate, toDate, aPct, bPct);
    }

    /**
     * 翻译自 ITEM_PKG.apply_item_flat
     * 对应 PL/SQL: update t_item set ... where item_id = p_item_id;
     * INSTEAD OF 触发器调本过程把平铺字段拼回对象列后更新主表
     */
    @Override
    @Transactional
    public void applyItemFlat(Long itemId, String itemName, BigDecimal stdCost,
                              BigDecimal listPrice, String status,
                              BigDecimal lengthCm, BigDecimal widthCm,
                              BigDecimal heightCm, BigDecimal weightKg) {
        // 对应 PL/SQL: 四个尺寸全空时整列置 null，避免存一个空壳对象
        DimensionVO dim = null;
        if (lengthCm != null || widthCm != null || heightCm != null || weightKg != null) {
            dim = new DimensionVO();
            dim.setLengthCm(lengthCm);
            dim.setWidthCm(widthCm);
            dim.setHeightCm(heightCm);
            dim.setWeightKg(weightKg);
        }

        int rows = itemMapper.applyItemFlat(itemId, itemName, stdCost, listPrice, status, dim);

        // 对应 PL/SQL: if sql%rowcount = 0 then exc_pkg.raise_biz_error(...)
        if (rows == 0) {
            throw new BusinessException(ErrorCode.ITEM_NOT_FOUND,
                    AppConstants.C_MOD_ITEM, "applyItemFlat",
                    "物料不存在 item_id=" + itemId, String.valueOf(itemId));
        }
    }
}
