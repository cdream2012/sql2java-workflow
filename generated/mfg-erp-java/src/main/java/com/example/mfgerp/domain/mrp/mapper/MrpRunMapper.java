package com.example.mfgerp.domain.mrp.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.domain.mrp.entity.MrpRun;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface MrpRunMapper extends BaseMapper<MrpRun> {

    /**
     * 翻译自 MRP_PKG — 更新 MRP run 状态
     * 对应 PL/SQL: update t_mrp_run set status = p_status where run_id = p_run_id
     */
    @Update("UPDATE t_mrp_run SET status = #{status} WHERE run_id = #{runId}")
    int updateStatus(@Param("runId") Long runId, @Param("status") String status);
}
