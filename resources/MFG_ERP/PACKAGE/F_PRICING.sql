-- 定价引擎: 多维阶梯规则命中
-- 取价优先级: 客户专属价目表 > 默认表; 同表内按 priority 小者先命中
-- 规则可按 物料 / 分类 / 客户 任意组合限定，min_qty/max_qty 划数量阶梯
-- 与 bank 的 calc_fee 同思路但叠了多维匹配 + 四种规则类型，命中后按类型算最终价

CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE MFG_ERP.F_PRICING IS
    -- Author : sql2java-workflow
    -- Created : 2026-07-03
    -- Purpose : 定价引擎: 多维阶梯规则命中 / 取价优先级: 客户专属价目表 > 默认表; 同表内按 priority 小者先命中 / 规则可按 物料 / 分类 / 客户 任意组合限定，min_qty/max_qty 划数量阶梯 / 与 bank 的 calc_fee 同思路但叠了多维匹配 + 四种规则类型，命中后按类型算最终价

    -- 取最终单价(命中规则后按类型算): LIST 直接取 / DISCOUNT_PCT 折扣 / DISCOUNT_AMT 减额 / OVERRIDE 一口价
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：取最终单价(命中规则后按类型算): LIST 直接取 / DISCOUNT_PCT 折扣 / DISCOUNT_AMT 减额 / OVERRIDE 一口价
    *****************************************************************/
    FUNCTION get_price(
        ii_item_id     IN NUMBER,
        ii_customer_id IN NUMBER   DEFAULT NULL,
        ii_qty         IN NUMBER   DEFAULT 1,
        id_as_of       IN DATE     DEFAULT NULL
    ) RETURN NUMBER;

    -- 取价明细: 基准价/最终价/命中规则/规则类型一并出参，便于销售单展示与审计
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：取价明细: 基准价/最终价/命中规则/规则类型一并出参，便于销售单展示与审计
    *****************************************************************/
    PROCEDURE get_price_detail(
        ii_item_id     IN  NUMBER,
        ii_customer_id IN  NUMBER,
        ii_qty         IN  NUMBER,
        oi_base_price  OUT NUMBER,
        oi_final_price OUT NUMBER,
        oi_rule_id     OUT NUMBER,
        os_rule_type   OUT VARCHAR2
    );

    -- 对整张销售单重新定价: 游标遍历订单行，where current of 逐行回写单价与折扣
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：对整张销售单重新定价: 游标遍历订单行，where current of 逐行回写单价与折扣
    *****************************************************************/
    PROCEDURE reprice_sales_order(ii_so_id IN NUMBER);

    -- 列出某物料/客户当前所有生效规则，按命中优先级排序(分析函数标注"是否会被选中")
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：列出某物料/客户当前所有生效规则，按命中优先级排序(分析函数标注"是否会被选中")
    *****************************************************************/
    PROCEDURE list_effective_rules(
        ii_item_id     IN  NUMBER,
        ii_customer_id IN  NUMBER   DEFAULT NULL,
        or_cur         OUT SYS_REFCURSOR
    );

END f_pricing;
