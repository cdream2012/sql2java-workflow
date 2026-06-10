package com.example.mfgerp.domain.pricing.service.impl;

import com.example.mfgerp.constant.AppConstants;
import com.example.mfgerp.domain.item.entity.Item;
import com.example.mfgerp.domain.item.mapper.ItemMapper;
import com.example.mfgerp.domain.pricing.dto.PriceDetailVO;
import com.example.mfgerp.domain.pricing.entity.PriceRule;
import com.example.mfgerp.domain.pricing.entity.SalesOrder;
import com.example.mfgerp.domain.pricing.entity.SoLine;
import com.example.mfgerp.domain.pricing.mapper.PriceListMapper;
import com.example.mfgerp.domain.pricing.mapper.PriceRuleMapper;
import com.example.mfgerp.domain.pricing.service.PricingService;
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
import java.util.List;

/**
 * 翻译自 PRICING_PKG
 * 两段式定价: 先定位价目表(客户专属 > 默认)，再在表内命中阶梯规则
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PricingServiceImpl implements PricingService {

    private final PriceRuleMapper priceRuleMapper;
    private final PriceListMapper priceListMapper;
    private final ItemMapper itemMapper;
    private final BizDateService bizDateService;

    @Override
    public BigDecimal getPrice(Long itemId, Long customerId, BigDecimal qty, LocalDate asOf) {
        PriceDetailVO detail = getPriceDetail(itemId, customerId, qty);
        return detail != null ? detail.getFinalPrice() : BigDecimal.ZERO;
    }

    @Override
    public PriceDetailVO getPriceDetail(Long itemId, Long customerId, BigDecimal qty) {
        LocalDate asOf = bizDateService.currBizDate();
        BigDecimal effectiveQty = qty != null ? qty : BigDecimal.ONE;

        // 对应 PL/SQL: select * into v_item from t_item where item_id = p_item_id
        Item item = itemMapper.getItem(itemId)
                .orElseThrow(() -> new BusinessException(ErrorCode.ITEM_NOT_FOUND,
                        AppConstants.C_MOD_PRICE, "getPriceDetail",
                        "物料不存在 item_id=" + itemId, String.valueOf(itemId)));

        // 对应 PL/SQL: p_base_price := v_item.list_price
        BigDecimal basePrice = item.getListPrice() != null ? item.getListPrice() : BigDecimal.ZERO;

        // 对应 PL/SQL: pick_price_list + match_rule + apply_rule
        // 委托给 Mapper 中的 SQL 完成
        PriceDetailVO detail = priceRuleMapper.getPriceDetail(itemId, customerId, effectiveQty, asOf);

        if (detail == null) {
            detail = new PriceDetailVO();
            detail.setBasePrice(basePrice);
            detail.setFinalPrice(basePrice);
            detail.setRuleId(null);
            detail.setRuleType(null);
        } else {
            // 对应 PL/SQL: if v_rule.rule_type in (LIST, OVERRIDE) then p_base_price := v_rule.price_value
            if (AppConstants.C_RULE_LIST.equals(detail.getRuleType())
                    || AppConstants.C_RULE_OVERRIDE.equals(detail.getRuleType())) {
                detail.setBasePrice(detail.getPriceValue());
            } else {
                detail.setBasePrice(basePrice);
            }
        }

        detail.setItemId(itemId);
        return detail;
    }

    /**
     * 翻译自 PRICING_PKG.reprice_sales_order
     * 对应 PL/SQL: 显式游标 + FOR UPDATE + WHERE CURRENT OF 逐行回写
     */
    @Override
    @Transactional
    public void repriceSalesOrder(Long soId) {
        LocalDate asOf = bizDateService.currBizDate();

        // 对应 PL/SQL: select * into v_so from t_sales_order where so_id = p_so_id for update
        // 对应 PL/SQL: if v_so.status not in ('DRAFT', 'CONFIRMED') then raise
        // Java 中先查询验证

        // 对应 PL/SQL: cursor c_line ... for update of unit_price, discount_pct
        // 逐行重定价
        priceRuleMapper.repriceSalesOrderLines(soId, asOf);

        // 对应 PL/SQL: update t_sales_order set total_amount = v_total where so_id = p_so_id
        priceRuleMapper.updateSalesOrderTotal(soId);
    }

    @Override
    public List<PriceRule> listEffectiveRules(Long itemId, Long customerId) {
        return priceRuleMapper.listEffectiveRules(itemId, customerId, bizDateService.currBizDate());
    }
}
