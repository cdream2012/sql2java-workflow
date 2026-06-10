package com.example.mfgerp;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cache.annotation.EnableCaching;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@MapperScan("com.example.mfgerp.**.mapper")
@EnableCaching
@EnableScheduling
public class MfgErpApplication {

    public static void main(String[] args) {
        SpringApplication.run(MfgErpApplication.class, args);
    }
}
