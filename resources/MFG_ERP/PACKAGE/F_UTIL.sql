-- 通用工具: 业务日期、参数读取(重载)、单据号、单位换算、脱敏格式化
-- 包级全局变量缓存业务日期，包初始化块首次引用时加载
-- get_param 用参数默认值的类型做重载: 同名三个，分别返回 varchar2/number/date

CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE MFG_ERP.F_UTIL IS
    -- Author : sql2java-workflow
    -- Created : 2026-07-03
    -- Purpose : 通用工具: 业务日期、参数读取(重载)、单据号、单位换算、脱敏格式化 / 包级全局变量缓存业务日期，包初始化块首次引用时加载 / get_param 用参数默认值的类型做重载: 同名三个，分别返回 varchar2/number/date

    -- 包级全局(刻意暴露在 spec，body 初始化块填充；sql2java 不能错翻成 static 常量)
    g_curr_biz_date  DATE;
    g_last_biz_date  DATE;
    g_next_biz_date  DATE;
    g_curr_operator  VARCHAR2(32);
    g_session_id     VARCHAR2(64);

    -- 条件编译开关: 静态布尔常量，body 里用 $IF MFG_ERP.F_UTIL.c_trace_compile $THEN ... 控制是否编进 trace 代码
    -- 生产编译为 false，trace 代码不进字节码；排障时改 true 重编
    c_trace_compile  CONSTANT BOOLEAN := FALSE;

    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：refresh_biz_date
    *****************************************************************/
    PROCEDURE refresh_biz_date;
    FUNCTION  curr_biz_date RETURN DATE;
    FUNCTION  last_biz_date RETURN DATE;
    FUNCTION  next_biz_date RETURN DATE;

    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：set_operator
    *****************************************************************/
    PROCEDURE set_operator(is_operator IN VARCHAR2);
    FUNCTION  get_operator RETURN VARCHAR2;

    -- 参数读取重载: 按默认值类型分派(overload by parameter type)
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：参数读取重载: 按默认值类型分派(overload by parameter type)
    *****************************************************************/
    FUNCTION get_param(is_key IN VARCHAR2, is_default IN VARCHAR2) RETURN VARCHAR2;
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：get_param
    *****************************************************************/
    FUNCTION get_param(is_key IN VARCHAR2, ii_default IN NUMBER)   RETURN NUMBER;
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：get_param
    *****************************************************************/
    FUNCTION get_param(is_key IN VARCHAR2, id_default IN DATE)     RETURN DATE;

    -- 单据号: 前缀 + YYYYMMDD + 序列后 6 位
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：单据号: 前缀 + YYYYMMDD + 序列后 6 位
    *****************************************************************/
    FUNCTION gen_doc_no(is_prefix IN VARCHAR2, ii_seq IN NUMBER, id_date IN DATE DEFAULT NULL) RETURN VARCHAR2;

    -- 单位换算(跨 category 抛 e_uom_incompatible)，deterministic 供 SQL 调用
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：单位换算(跨 category 抛 e_uom_incompatible)，deterministic 供 SQL 调用
    *****************************************************************/
    FUNCTION convert_qty(ii_qty IN NUMBER, is_from_uom IN VARCHAR2, is_to_uom IN VARCHAR2) RETURN NUMBER;

    -- 数量按物料基本单位小数位规整
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：数量按物料基本单位小数位规整
    *****************************************************************/
    FUNCTION round_qty(ii_qty IN NUMBER, is_uom IN VARCHAR2) RETURN NUMBER;

    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：format_qty
    *****************************************************************/
    FUNCTION format_qty(ii_qty IN NUMBER, is_uom IN VARCHAR2 DEFAULT NULL) RETURN VARCHAR2;

    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：clear_cache
    *****************************************************************/
    PROCEDURE clear_cache;

END f_util;
