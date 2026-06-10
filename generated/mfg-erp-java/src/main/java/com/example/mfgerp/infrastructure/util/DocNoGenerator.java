package com.example.mfgerp.infrastructure.util;

import java.time.LocalDate;
import java.time.format.DateTimeFormatter;

/**
 * 翻译自 UTIL_PKG.gen_doc_no
 * 对应 PL/SQL:
 *   return p_prefix || to_char(nvl(p_date, curr_biz_date), 'YYYYMMDD')
 *       || lpad(mod(p_seq, 1000000), 6, '0');
 */
public class DocNoGenerator {

    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyyMMdd");

    private DocNoGenerator() {}

    /**
     * 生成单据号: 前缀 + YYYYMMDD + 序列后6位
     * 对应 PL/SQL: gen_doc_no(p_prefix, p_seq, p_date)
     *
     * @param prefix 前缀 (如 "PO", "SO", "TXN")
     * @param seq    序列号
     * @param date   日期，null 则使用当天日期
     * @return 单据号
     */
    public static String generate(String prefix, long seq, LocalDate date) {
        LocalDate effectiveDate = date != null ? date : LocalDate.now();
        // 对应 PL/SQL: lpad(mod(p_seq, 1000000), 6, '0')
        String seqPart = String.format("%06d", Math.abs(seq % 1000000));
        return prefix + effectiveDate.format(DATE_FMT) + seqPart;
    }

    /**
     * 使用当前业务日期生成单据号
     * 对应 PL/SQL: gen_doc_no(p_prefix, p_seq) — p_date default null
     */
    public static String generate(String prefix, long seq) {
        return generate(prefix, seq, null);
    }
}
