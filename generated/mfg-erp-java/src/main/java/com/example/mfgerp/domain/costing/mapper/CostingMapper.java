package com.example.mfgerp.domain.costing.mapper;

import com.example.mfgerp.domain.costing.dto.FifoLayerVO;
import com.example.mfgerp.domain.costing.dto.LandedCostVO;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;

import java.math.BigDecimal;
import java.util.List;

@Mapper
public interface CostingMapper {

    List<FifoLayerVO> fifoLayers(@Param("itemId") Long itemId,
                                 @Param("warehouseId") Long warehouseId);

    List<FifoLayerVO> inventoryValue(@Param("warehouseId") Long warehouseId);

    void recomputeAvgCost(@Param("itemId") Long itemId,
                          @Param("warehouseId") Long warehouseId);

    List<LandedCostVO> landedCostReport(@Param("poId") Long poId,
                                         @Param("freight") BigDecimal freight,
                                         @Param("duty") BigDecimal duty,
                                         @Param("basis") String basis);

    void updateStdCost(@Param("itemId") Long itemId, @Param("stdCost") BigDecimal stdCost);
}
