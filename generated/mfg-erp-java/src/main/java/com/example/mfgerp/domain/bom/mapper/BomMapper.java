package com.example.mfgerp.domain.bom.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.domain.bom.dto.BomComponentVO;
import com.example.mfgerp.domain.bom.dto.ExplosionRowVO;
import com.example.mfgerp.domain.bom.entity.BomHeader;
import com.example.mfgerp.domain.bom.entity.BomLine;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

@Mapper
public interface BomMapper extends BaseMapper<BomHeader> {

    List<BomComponentVO> getComponents(@Param("bomId") Long bomId);

    Optional<Long> getActiveBomId(@Param("itemId") Long itemId, @Param("asOf") LocalDate asOf);

    /**
     * 翻译自 BOM_PKG.explode_table 的组件查询
     * 按父项物料查当层组件
     */
    List<BomComponentVO> getComponentsForExplode(@Param("parentItemId") Long parentItemId,
                                                  @Param("asOf") LocalDate asOf);

    /**
     * 翻译自 BOM_PKG.explode_cte (递归 CTE 版)
     */
    List<ExplosionRowVO> explodeCte(@Param("itemId") Long itemId,
                                     @Param("qty") BigDecimal qty);

    /**
     * 翻译自 BOM_PKG.where_used
     */
    List<ExplosionRowVO> whereUsed(@Param("componentId") Long componentItemId,
                                    @Param("maxLevels") Integer maxLevels);

    /**
     * 翻译自 BOM_PKG.unit_cost 的 BOM 头查询
     */
    Optional<BomHeader> getActiveBomHeader(@Param("itemId") Long itemId,
                                            @Param("asOf") LocalDate asOf);

    /**
     * 翻译自 BOM_PKG.unit_cost 的 BOM 行查询
     */
    List<BomLine> getBomLines(@Param("bomId") Long bomId);

    /**
     * 翻译自 BOM_PKG.compare_versions (简化版，直接在 Service 中用 Java 集合比较)
     */
    List<ExplosionRowVO> compareVersions(@Param("bomIdOld") Long bomIdOld,
                                          @Param("bomIdNew") Long bomIdNew);
}
