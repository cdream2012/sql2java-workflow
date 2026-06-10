package com.example.mfgerp.infrastructure.exception;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.example.mfgerp.infrastructure.entity.ErrorLog;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface ErrorLogMapper extends BaseMapper<ErrorLog> {
}
