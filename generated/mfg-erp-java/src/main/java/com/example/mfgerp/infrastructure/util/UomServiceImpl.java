package com.example.mfgerp.infrastructure.util;

import com.example.mfgerp.constant.AppConstants;
import com.example.mfgerp.infrastructure.entity.Uom;
import com.example.mfgerp.infrastructure.entity.UomConversion;
import com.example.mfgerp.infrastructure.exception.BusinessException;
import com.example.mfgerp.infrastructure.exception.ErrorCode;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cache.annotation.CacheEvict;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 翻译自 UTIL_PKG 单位换算函数
 * 包级变量 g_uom_digits / g_uom_cat → Caffeine 缓存 + 本地缓存
 */
@Service
@RequiredArgsConstructor
public class UomServiceImpl implements UomService {

    private static final Logger log = LoggerFactory.getLogger(UomServiceImpl.class);

    private final UomMapper uomMapper;

    // 对应 PL/SQL 包级变量: g_uom_digits / g_uom_cat
    // 使用本地缓存保存 UOM 元数据，避免每次查询数据库
    private final Map<String, Integer> uomDigitsCache = new ConcurrentHashMap<>();
    private final Map<String, String> uomCategoryCache = new ConcurrentHashMap<>();

    /**
     * 翻译自 UTIL_PKG.load_uom_cache
     * 对应 PL/SQL:
     *   g_uom_digits.delete; g_uom_cat.delete;
     *   for r in (select uom_code, uom_category, decimal_digits from t_uom) loop
     *     g_uom_digits(r.uom_code) := r.decimal_digits;
     *     g_uom_cat(r.uom_code)    := r.uom_category;
     *   end loop;
     */
    private void loadUomCache() {
        uomDigitsCache.clear();
        uomCategoryCache.clear();
        List<Uom> uomList = uomMapper.selectList(null);
        for (Uom uom : uomList) {
            uomCategoryCache.put(uom.getUomCode(), uom.getUomCategory());
            uomDigitsCache.put(uom.getUomCode(),
                    uom.getDecimalDigits() != null ? uom.getDecimalDigits().intValue() : 4);
        }
    }

    /**
     * 翻译自 UTIL_PKG.convert_qty
     * 对应 PL/SQL:
     *   if p_from_uom = p_to_uom or p_qty is null then return p_qty; end if;
     *   -- 检查单位是否存在和同类
     *   -- 先尝试直接换算系数，无则枢轴折算
     *   return round_qty(p_qty * v_factor, p_to_uom);
     */
    @Override
    public BigDecimal convertQty(BigDecimal qty, String fromUom, String toUom) {
        // 对应 PL/SQL: if p_from_uom = p_to_uom or p_qty is null then return p_qty;
        if (fromUom.equals(toUom) || qty == null) {
            return qty;
        }

        // 对应 PL/SQL: if g_uom_cat.count = 0 then load_uom_cache; end if;
        if (uomCategoryCache.isEmpty()) {
            loadUomCache();
        }

        // 对应 PL/SQL: 检查单位是否存在
        if (!uomCategoryCache.containsKey(fromUom) || !uomCategoryCache.containsKey(toUom)) {
            throw new BusinessException(ErrorCode.UOM_NOT_FOUND,
                    AppConstants.C_MOD_UTIL, "convertQty",
                    "单位未定义 from=" + fromUom + " to=" + toUom, fromUom);
        }

        // 对应 PL/SQL: 检查单位是否同类
        String fromCat = uomCategoryCache.get(fromUom);
        String toCat = uomCategoryCache.get(toUom);
        if (!fromCat.equals(toCat)) {
            throw new BusinessException(ErrorCode.UOM_INCOMPATIBLE,
                    AppConstants.C_MOD_UTIL, "convertQty",
                    "单位不同类不可换算 " + fromUom + "(" + fromCat + ") -> "
                            + toUom + "(" + toCat + ")", fromUom);
        }

        // 对应 PL/SQL: $if util_pkg.c_trace_compile $then ... $end
        log.trace("convert_qty {} {} -> {}", qty, fromUom, toUom);

        BigDecimal factor;
        try {
            // 对应 PL/SQL: select factor into v_factor from t_uom_conversion where from_uom = p_from_uom and to_uom = p_to_uom;
            factor = uomMapper.getConversionFactor(fromUom, toUom);
        } catch (EmptyResultDataAccessException e) {
            // 对应 PL/SQL: when no_data_found then
            // 同类但缺直接换算系数，回退按基本单位枢轴折算
            // select f.factor / t.factor into v_factor from t_uom_conversion f
            //   join t_uom_conversion t on t.from_uom = p_to_uom and t.to_uom = f.to_uom
            //  where f.from_uom = p_from_uom and rownum = 1;
            BigDecimal pivotFactor = uomMapper.getPivotConversionFactor(fromUom, toUom);
            factor = pivotFactor;
        }

        // 对应 PL/SQL: return round_qty(p_qty * v_factor, p_to_uom);
        return roundQty(qty.multiply(factor), toUom);
    }

    /**
     * 翻译自 UTIL_PKG.round_qty
     * 对应 PL/SQL:
     *   if p_qty is null then return null; end if;
     *   if g_uom_digits.count = 0 then load_uom_cache; end if;
     *   v_digits := case when g_uom_digits.exists(p_uom) then g_uom_digits(p_uom) else 4 end;
     *   return round(p_qty, v_digits);
     */
    @Override
    public BigDecimal roundQty(BigDecimal qty, String uom) {
        if (qty == null) {
            return null;
        }
        if (uomDigitsCache.isEmpty()) {
            loadUomCache();
        }
        int digits = uomDigitsCache.getOrDefault(uom != null ? uom : "", 4);
        return qty.setScale(digits, RoundingMode.HALF_UP);
    }

    /**
     * 翻译自 UTIL_PKG.format_qty
     * 对应 PL/SQL:
     *   v_digits := case when p_uom is not null and g_uom_digits.exists(p_uom)
     *                    then g_uom_digits(p_uom) else 2 end;
     *   v_fmt := 'FM999,999,999,990' || case when v_digits > 0 then '.' || rpad('0', v_digits, '0') end;
     *   return trim(to_char(round(p_qty, v_digits), v_fmt))
     *       || case when p_uom is not null then ' ' || p_uom end;
     */
    @Override
    public String formatQty(BigDecimal qty, String uom) {
        if (qty == null) {
            return null;
        }
        if (uomDigitsCache.isEmpty()) {
            loadUomCache();
        }
        int digits = (uom != null && uomDigitsCache.containsKey(uom))
                ? uomDigitsCache.get(uom) : 2;
        BigDecimal rounded = qty.setScale(digits, RoundingMode.HALF_UP);
        String formatted = String.format("%,." + digits + "f", rounded);
        if (uom != null) {
            formatted += " " + uom;
        }
        return formatted;
    }

    /**
     * 对应 UTIL_PKG.clear_cache
     * 清除 UOM 缓存
     */
    @CacheEvict(value = "uomCache", allEntries = true)
    public void clearCache() {
        uomDigitsCache.clear();
        uomCategoryCache.clear();
    }
}
