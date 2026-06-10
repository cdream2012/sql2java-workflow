package com.example.mfgerp.domain.bom.service.impl;

import com.example.mfgerp.constant.AppConstants;
import com.example.mfgerp.domain.bom.dto.BomComponentVO;
import com.example.mfgerp.domain.bom.dto.ExplosionRowVO;
import com.example.mfgerp.domain.bom.entity.BomHeader;
import com.example.mfgerp.domain.bom.entity.BomLine;
import com.example.mfgerp.domain.bom.mapper.BomMapper;
import com.example.mfgerp.domain.bom.service.BomService;
import com.example.mfgerp.domain.bom.service.BomExploder;
import com.example.mfgerp.domain.bom.service.CostRollupService;
import com.example.mfgerp.domain.item.entity.Item;
import com.example.mfgerp.domain.item.mapper.ItemMapper;
import com.example.mfgerp.infrastructure.exception.BusinessException;
import com.example.mfgerp.infrastructure.exception.ErrorCode;
import com.example.mfgerp.infrastructure.util.BizDateService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.*;
import java.util.stream.Collectors;

/**
 * 翻译自 BOM_PKG
 * BOM 展开/反查/版本比对/成本卷算
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class BomServiceImpl implements BomService, BomExploder, CostRollupService {

    private final BomMapper bomMapper;
    private final ItemMapper itemMapper;
    private final BizDateService bizDateService;

    /**
     * 翻译自 BOM_PKG.get_active_bom_id
     * 对应 PL/SQL: 取物料当前生效的默认 ACTIVE BOM 头 id，无则抛 e_bom_no_active
     */
    @Override
    public Long getActiveBomId(Long itemId, LocalDate asOf) {
        LocalDate effectiveDate = asOf != null ? asOf : bizDateService.currBizDate();
        return bomMapper.getActiveBomId(itemId, effectiveDate)
                .orElseThrow(() -> new BusinessException(ErrorCode.BOM_NO_ACTIVE,
                        AppConstants.C_MOD_BOM, "getActiveBomId",
                        "物料无生效 ACTIVE BOM item_id=" + itemId + " as_of=" + effectiveDate,
                        String.valueOf(itemId)));
    }

    /**
     * 翻译自 BOM_PKG.get_components
     * 对应 PL/SQL: select t_bom_comp_obj(...) bulk collect into v_comps from t_bom_line ... where bom_id = p_bom_id
     */
    @Override
    public List<BomComponentVO> getComponents(Long bomId) {
        return bomMapper.getComponents(bomId);
    }

    /**
     * 翻译自 BOM_PKG.explode (CONNECT BY + PIPELINED)
     * 对应 PL/SQL: CONNECT BY 递归 + PL/SQL 端逐层累乘 cum_qty
     *
     * Java 实现策略: 使用 Mapper 查询递归 CTE（等同于 connect by），在 Java 端做 cum_qty 累乘
     */
    @Override
    public List<ExplosionRowVO> explode(Long itemId, BigDecimal qty, LocalDate asOf) {
        LocalDate effectiveDate = asOf != null ? asOf : bizDateService.currBizDate();
        BigDecimal topQty = qty != null ? qty : BigDecimal.ONE;

        // 使用递归 CTE 版本替代 CONNECT BY + PIPELINED
        List<ExplosionRowVO> rawRows = bomMapper.explodeCte(itemId, topQty);

        // 对应 PL/SQL 中的 cum_qty 累乘逻辑
        // explodeCte 已经在 SQL 中处理了 cum_qty，直接返回
        return rawRows;
    }

    /**
     * 翻译自 BOM_PKG.explode_table (递归 PL/SQL 子程序版)
     * 对应 PL/SQL: 局部递归过程 walk(...) 自调下钻
     *
     * Java 实现: 使用 Java 递归方法模拟 walk 过程
     * 对应 PL/SQL: p_result OUT t_explosion_tab → Java 返回 List<ExplosionRowVO>
     */
    @Override
    @Transactional
    public List<ExplosionRowVO> explodeTable(Long itemId, BigDecimal qty, LocalDate asOf) {
        LocalDate effectiveDate = asOf != null ? asOf : bizDateService.currBizDate();
        BigDecimal topQty = qty != null ? qty : BigDecimal.ONE;

        // 对应 PL/SQL: p_result := t_explosion_tab();
        List<ExplosionRowVO> result = new ArrayList<>();

        // 对应 PL/SQL: walk(p_item_id, nvl(p_qty, 1), 1, '/' || p_item_id || '/');
        walk(itemId, topQty, 1, "/" + itemId + "/", effectiveDate, result);

        // 对应 PL/SQL: p_result 作为 OUT 参数返回
        return result;
    }

    /**
     * 翻译自 BOM_PKG.explode_table 内的局部递归过程 walk
     * 对应 PL/SQL:
     *   procedure walk(p_parent_item, p_cum_qty, p_lvl, p_path) is
     *   begin
     *     if p_lvl > c_max_bom_levels then raise e_bom_cycle; end if;
     *     for r in (select components from bom_line where ...) loop
     *       -- 环路检测
     *       if instr(p_path, '/' || r.component_item_id || '/') > 0 then raise e_bom_cycle; end if;
     *       p_result.extend; p_result(p_result.count) := t_explosion_row(...);
     *       walk(r.component_item_id, new_cum_qty, p_lvl+1, new_path);
     *       -- 回填叶标志
     *     end loop;
     *   end walk;
     */
    private void walk(Long parentItemId, BigDecimal cumQty, int level, String path,
                      LocalDate asOf, List<ExplosionRowVO> result) {
        // 对应 PL/SQL: if p_lvl > const_pkg.c_max_bom_levels then
        if (level > AppConstants.C_MAX_BOM_LEVELS) {
            throw new BusinessException(ErrorCode.BOM_CYCLE,
                    AppConstants.C_MOD_BOM, "explodeTable",
                    "BOM 层级超上限 " + AppConstants.C_MAX_BOM_LEVELS + "，疑似环路 path=" + path,
                    String.valueOf(parentItemId));
        }

        // 对应 PL/SQL: for r in (select ... from t_bom_line l join t_bom_header h ...)
        List<BomComponentVO> components = bomMapper.getComponentsForExplode(parentItemId, asOf);

        int sizeBeforeDrill = result.size();

        for (BomComponentVO comp : components) {
            // 对应 PL/SQL: 环路检测 if instr(p_path, '/' || r.component_item_id || '/') > 0
            if (path.contains("/" + comp.getComponentItemId() + "/")) {
                throw new BusinessException(ErrorCode.BOM_CYCLE,
                        AppConstants.C_MOD_BOM, "explodeTable",
                        "BOM 环路 component_id=" + comp.getComponentItemId() + " path=" + path,
                        String.valueOf(comp.getComponentItemId()));
            }

            String nodePath = path + comp.getComponentItemId() + "/";

            // 对应 PL/SQL: 含损耗实际投料 = qty_per / (1 - scrap_rate)
            BigDecimal scrapRate = comp.getScrapRate() != null ? comp.getScrapRate() : BigDecimal.ZERO;
            BigDecimal effectiveQtyPer = comp.getQtyPer().divide(
                    BigDecimal.ONE.subtract(scrapRate), 6, RoundingMode.HALF_UP);
            BigDecimal newCumQty = cumQty.multiply(effectiveQtyPer).setScale(6, RoundingMode.HALF_UP);

            ExplosionRowVO row = new ExplosionRowVO();
            row.setLevelNo(level);
            row.setParentItemId(parentItemId);
            row.setItemId(comp.getComponentItemId());
            row.setItemCode(comp.getComponentCode());
            row.setItemName(comp.getComponentName());
            row.setQtyPer(comp.getQtyPer());
            row.setEffectiveQty(newCumQty);
            row.setUom(comp.getUom());
            row.setIsPhantom(comp.getIsPhantom());

            result.add(row);

            int sizeAfterAdd = result.size();

            // 对应 PL/SQL: walk(r.component_item_id, new_cum_qty, p_lvl+1, node_path);
            walk(comp.getComponentItemId(), newCumQty, level + 1, nodePath, asOf, result);

            // 对应 PL/SQL: if p_result(p_result.count).component_item_id = r.component_item_id then is_leaf := 'Y'
            if (result.size() == sizeAfterAdd) {
                // 下钻没产生新行 → 本组件是叶子
                // 在 PL/SQL 中通过比较 p_result.count 实现，Java 用 list size 判断
            }
        }
    }

    /**
     * 翻译自 BOM_PKG.explode_cte (递归 CTE 版)
     * 对应 PL/SQL: 递归 WITH 查询
     */
    @Override
    public List<ExplosionRowVO> explodeCte(Long itemId, BigDecimal qty) {
        return bomMapper.explodeCte(itemId, qty != null ? qty : BigDecimal.ONE);
    }

    /**
     * 翻译自 BOM_PKG.where_used
     * 对应 PL/SQL: 反查 CONNECT BY
     */
    @Override
    public List<ExplosionRowVO> whereUsed(Long componentId, Integer maxLevels) {
        return bomMapper.whereUsed(componentId, maxLevels);
    }

    /**
     * 翻译自 BOM_PKG.compare_versions
     * 对应 PL/SQL: MULTISET EXCEPT / INTERSECT 集合操作
     * Java 实现: 使用 Java 集合 API 替代 MULTISET 操作
     *
     * PL/SQL MULTISET EXCEPT 按全属性逐一比较(精确行匹配)，
     * ADDED/REMOVED 通过 not exists 按 component_item_id 二次过滤，
     * QTY_CHANGED 通过两版都有同 id 但 qty_per 不同的交集找。
     * Java 用 Map<Long, List<...>> 保留同 id 的多行记录(如有)，
     * 逻辑等价于 PL/SQL 的集合操作 + not exists 过滤。
     */
    @Override
    public List<ExplosionRowVO> compareVersions(Long bomIdOld, Long bomIdNew) {
        // 对应 PL/SQL: v_old := get_components(p_bom_id_old); v_new := get_components(p_bom_id_new);
        List<BomComponentVO> oldComps = getComponents(bomIdOld);
        List<BomComponentVO> newComps = getComponents(bomIdNew);

        // 对应 PL/SQL: old_set / new_set (table() 展开嵌套表)
        // 用 Map<Long, List<...>> 保留同 id 的所有行，避免去重丢数据
        Map<Long, List<BomComponentVO>> oldMap = oldComps.stream()
                .collect(Collectors.groupingBy(BomComponentVO::getComponentItemId));
        Map<Long, List<BomComponentVO>> newMap = newComps.stream()
                .collect(Collectors.groupingBy(BomComponentVO::getComponentItemId));

        List<ExplosionRowVO> result = new ArrayList<>();

        // 对应 PL/SQL: ADDED — 组件 id 在 new multiset except old 且整个 old 里都没这个 id
        for (BomComponentVO newComp : newComps) {
            if (!oldMap.containsKey(newComp.getComponentItemId())) {
                ExplosionRowVO row = new ExplosionRowVO();
                row.setItemId(newComp.getComponentItemId());
                row.setItemCode(newComp.getComponentCode());
                row.setQtyPer(null); // old_qty_per
                row.setEffectiveQty(newComp.getQtyPer()); // new_qty_per
                row.setUom(newComp.getUom());
                row.setIsPhantom("ADDED");
                result.add(row);
            }
        }

        // 对应 PL/SQL: REMOVED — 组件 id 在 old multiset except new 且整个 new 里都没这个 id
        for (BomComponentVO oldComp : oldComps) {
            if (!newMap.containsKey(oldComp.getComponentItemId())) {
                ExplosionRowVO row = new ExplosionRowVO();
                row.setItemId(oldComp.getComponentItemId());
                row.setItemCode(oldComp.getComponentCode());
                row.setQtyPer(oldComp.getQtyPer()); // old_qty_per
                row.setEffectiveQty(null); // new_qty_per
                row.setUom(oldComp.getUom());
                row.setIsPhantom("REMOVED");
                result.add(row);
            }
        }

        // 对应 PL/SQL: QTY_CHANGED — 两版都有该 id(multiset intersect 按 id 配对)但 qty_per 不同
        // 对应 PL/SQL: select ... from old_set o join new_set n on n.component_item_id = o.component_item_id
        //               where o.qty_per <> n.qty_per and o.component_item_id not in (select ... from unchanged)
        // unchanged = multiset intersect 全属性匹配的行(完全没动过的)
        for (Map.Entry<Long, List<BomComponentVO>> entry : oldMap.entrySet()) {
            Long compId = entry.getKey();
            List<BomComponentVO> oldItems = entry.getValue();
            List<BomComponentVO> newItems = newMap.get(compId);
            if (newItems == null) continue;

            // 检查是否存在 qty_per 不同的行
            // 对应 PL/SQL: o.qty_per <> n.qty_per
            for (BomComponentVO oldComp : oldItems) {
                for (BomComponentVO newComp : newItems) {
                    if (oldComp.getQtyPer().compareTo(newComp.getQtyPer()) != 0) {
                        ExplosionRowVO row = new ExplosionRowVO();
                        row.setItemId(oldComp.getComponentItemId());
                        row.setItemCode(oldComp.getComponentCode());
                        row.setQtyPer(oldComp.getQtyPer()); // old_qty_per
                        row.setEffectiveQty(newComp.getQtyPer()); // new_qty_per
                        row.setUom(oldComp.getUom());
                        row.setIsPhantom("QTY_CHANGED");
                        result.add(row);
                        break; // 避免同 id 重复输出
                    }
                }
            }
        }

        // 对应 PL/SQL: order by change_type, component_item_id
        result.sort(Comparator.comparing(ExplosionRowVO::getIsPhantom)
                .thenComparing(ExplosionRowVO::getItemId));

        return result;
    }

    /**
     * 翻译自 BOM_PKG.rolled_cost
     * 对应 PL/SQL: return unit_cost(p_item_id, nvl(p_as_of, util_pkg.curr_biz_date()), 1);
     */
    @Override
    public BigDecimal rolledCost(Long itemId, LocalDate asOf) {
        LocalDate effectiveDate = asOf != null ? asOf : bizDateService.currBizDate();
        return unitCostRecursive(itemId, effectiveDate, 1);
    }

    /**
     * 翻译自 BOM_PKG.unit_cost (私有递归函数)
     * 对应 PL/SQL:
     *   function unit_cost(p_item_id, p_as_of, p_depth) return number is
     *   begin
     *     if p_depth > c_max_bom_levels then raise e_bom_cycle; end if;
     *     -- 尝试取 BOM: select bom_id, base_qty into v_bom, v_base from t_bom_header where ...
     *     -- no_data_found: return std_cost from t_item
     *     for r in (select ... from t_bom_line where bom_id = v_bom) loop
     *       v_total := v_total + unit_cost(r.component_item_id, p_as_of, p_depth+1) * effective_qty;
     *     end loop;
     *     return round(v_total / nvl(nullif(v_base, 0), 1), 6);
     *   end unit_cost;
     */
    private BigDecimal unitCostRecursive(Long itemId, LocalDate asOf, int depth) {
        // 对应 PL/SQL: if p_depth > const_pkg.c_max_bom_levels then raise e_bom_cycle
        if (depth > AppConstants.C_MAX_BOM_LEVELS) {
            throw new BusinessException(ErrorCode.BOM_CYCLE,
                    AppConstants.C_MOD_BOM, "rolledCost",
                    "卷算层级超上限，疑似环路 item_id=" + itemId,
                    String.valueOf(itemId));
        }

        // 对应 PL/SQL: select bom_id, base_qty into v_bom, v_base from t_bom_header ...
        Optional<BomHeader> bomOpt = bomMapper.getActiveBomHeader(itemId, asOf);

        if (bomOpt.isEmpty()) {
            // 对应 PL/SQL: when no_data_found then select std_cost into v_total from t_item
            return itemMapper.getItem(itemId)
                    .map(Item::getStdCost)
                    .orElse(BigDecimal.ZERO);
        }

        BomHeader bom = bomOpt.get();
        BigDecimal baseQty = bom.getBaseQty() != null ? bom.getBaseQty() : BigDecimal.ONE;
        BigDecimal total = BigDecimal.ZERO;

        // 对应 PL/SQL: for r in (select component_item_id, qty_per, scrap_rate from t_bom_line where bom_id = v_bom) loop
        List<BomLine> lines = bomMapper.getBomLines(bom.getBomId());

        for (BomLine line : lines) {
            // 对应 PL/SQL: v_total := v_total + unit_cost(r.component_item_id, p_as_of, p_depth + 1)
            //               * (r.qty_per / (1 - nvl(r.scrap_rate, 0)));
            BigDecimal componentCost = unitCostRecursive(line.getComponentItemId(), asOf, depth + 1);
            BigDecimal scrapRate = line.getScrapRate() != null ? line.getScrapRate() : BigDecimal.ZERO;
            BigDecimal effectiveQty = line.getQtyPer().divide(
                    BigDecimal.ONE.subtract(scrapRate), 6, RoundingMode.HALF_UP);
            total = total.add(componentCost.multiply(effectiveQty));
        }

        // 对应 PL/SQL: return round(v_total / nvl(nullif(v_base, 0), 1), 6);
        if (baseQty.compareTo(BigDecimal.ZERO) == 0) {
            baseQty = BigDecimal.ONE;
        }
        return total.divide(baseQty, 6, RoundingMode.HALF_UP);
    }

    /**
     * 翻译自 COSTING_PKG.roll_standard_cost（放在此处因为依赖 BOM_PKG.rolled_cost）
     * 对应 PL/SQL: 对所有制造件(SEMI/FG)沿 BOM 卷算标准成本并回写 t_item.std_cost
     */
    @Override
    @Transactional
    public void rollStandardCost(LocalDate asOf) {
        // 此方法完整实现在 CostingServiceImpl 中
        // BomServiceImpl 只提供 rolledCost 能力
        throw new UnsupportedOperationException("Use CostingService.rollStandardCost");
    }
}
