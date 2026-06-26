-- 定价引擎: 多维阶梯规则命中
-- 取价优先级: 客户专属价目表 > 默认表; 同表内按 priority 小者先命中
-- 规则可按 物料 / 分类 / 客户 任意组合限定，min_qty/max_qty 划数量阶梯
-- 与 bank 的 calc_fee 同思路但叠了多维匹配 + 四种规则类型，命中后按类型算最终价

CREATE OR REPLACE PACKAGE pricing_pkg AS

    -- 取最终单价(命中规则后按类型算): LIST 直接取 / DISCOUNT_PCT 折扣 / DISCOUNT_AMT 减额 / OVERRIDE 一口价
    FUNCTION get_price(
        p_item_id     IN NUMBER,
        p_customer_id IN NUMBER   DEFAULT NULL,
        p_qty         IN NUMBER   DEFAULT 1,
        p_as_of       IN DATE     DEFAULT NULL
    ) RETURN NUMBER;

    -- 取价明细: 基准价/最终价/命中规则/规则类型一并出参，便于销售单展示与审计
    PROCEDURE get_price_detail(
        p_item_id     IN  NUMBER,
        p_customer_id IN  NUMBER,
        p_qty         IN  NUMBER,
        p_base_price  OUT NUMBER,
        p_final_price OUT NUMBER,
        p_rule_id     OUT NUMBER,
        p_rule_type   OUT VARCHAR2
    );

    -- 对整张销售单重新定价: 游标遍历订单行，where current of 逐行回写单价与折扣
    PROCEDURE reprice_sales_order(p_so_id IN NUMBER);

    -- 列出某物料/客户当前所有生效规则，按命中优先级排序(分析函数标注"是否会被选中")
    PROCEDURE list_effective_rules(
        p_item_id     IN  NUMBER,
        p_customer_id IN  NUMBER   DEFAULT NULL,
        p_cur         OUT SYS_REFCURSOR
    );

END pricing_pkg;
/

CREATE OR REPLACE PACKAGE BODY pricing_pkg AS

    -- 取价的两段式: 先定位价目表(客户专属 > 默认)，再在表内命中阶梯规则
    -- 同表内命中顺序: priority 小者先; priority 相同时细粒度优先(物料级 > 分类级 > 通配)
    -- 拿不到规则不直接抛错，退回 t_item.list_price —— 销售单总能出价，缺规则只是"未配特价"
    -- 真要强约束(如合同价必须命中)可在调用侧判 rule_id is null，这里给最大兼容

    -- 私有: 选生效价目表 id。客户挂了专属表且在有效期内就用它，否则落默认表
    FUNCTION pick_price_list(
        p_customer_id IN NUMBER,
        p_as_of       IN DATE
    ) RETURN NUMBER IS
        v_list_id t_price_list.price_list_id%TYPE;
    BEGIN
        IF p_customer_id IS NOT NULL THEN
            BEGIN
                SELECT pl.price_list_id
                  INTO v_list_id
                  FROM t_customer c
                  JOIN t_price_list pl ON pl.price_list_id = c.price_list_id
                 WHERE c.customer_id = p_customer_id
                   AND pl.is_active = 'Y'
                   AND pl.valid_from <= p_as_of
                   AND (pl.valid_to IS NULL OR pl.valid_to >= p_as_of);
                RETURN v_list_id;
            EXCEPTION
                WHEN NO_DATA_FOUND THEN
                    NULL;  -- 客户没挂专属表或已失效，往下落默认表
            END;
        END IF;

        BEGIN
            SELECT price_list_id
              INTO v_list_id
              FROM t_price_list
             WHERE is_default = 'Y'
               AND is_active = 'Y'
               AND valid_from <= p_as_of
               AND (valid_to IS NULL OR valid_to >= p_as_of);
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_price_list_not_found, const_pkg.c_mod_price, 'pick_price_list',
                    '无可用默认价目表 as_of=' || TO_CHAR(p_as_of, 'YYYY-MM-DD'),
                    TO_CHAR(p_customer_id));
            WHEN TOO_MANY_ROWS THEN
                -- 配了多张默认表是配置错误，取一张继续但留日志
                exc_pkg.log_error(
                    const_pkg.c_err_price_list_not_found, const_pkg.c_mod_price, 'pick_price_list',
                    '默认价目表多于一张，任取其一', NULL, NULL, 'WARN');
                SELECT MIN(price_list_id) INTO v_list_id
                  FROM t_price_list
                 WHERE is_default = 'Y' AND is_active = 'Y'
                   AND valid_from <= p_as_of
                   AND (valid_to IS NULL OR valid_to >= p_as_of);
        END;
        RETURN v_list_id;
    END pick_price_list;


    -- 私有: 在指定价目表内命中一条规则(子查询 order by + rownum=1 取首条)
    -- 命中维度: item / category / customer 列允许为空表示"不限定"，等于该列即匹配
    -- 排序键先 priority 后特异度，让物料级规则盖过分类级，避免乱配 priority 时取错档
    FUNCTION match_rule(
        p_price_list_id IN NUMBER,
        p_item_id       IN NUMBER,
        p_category_id   IN NUMBER,
        p_customer_id   IN NUMBER,
        p_qty           IN NUMBER,
        p_as_of         IN DATE
    ) RETURN t_price_rule%ROWTYPE IS
        v_rule t_price_rule%ROWTYPE;
    BEGIN
        SELECT *
          INTO v_rule
          FROM (
                SELECT r.*
                  FROM t_price_rule r
                 WHERE r.price_list_id = p_price_list_id
                   AND r.is_active = 'Y'
                   AND r.valid_from <= p_as_of
                   AND (r.valid_to IS NULL OR r.valid_to >= p_as_of)
                   AND (r.item_id IS NULL OR r.item_id = p_item_id)
                   AND (r.category_id IS NULL OR r.category_id = p_category_id)
                   AND (r.customer_id IS NULL OR r.customer_id = p_customer_id)
                   AND r.min_qty <= p_qty
                   AND (r.max_qty IS NULL OR r.max_qty > p_qty)
                 ORDER BY r.priority,
                          CASE WHEN r.item_id IS NOT NULL THEN 0 ELSE 1 END,
                          CASE WHEN r.customer_id IS NOT NULL THEN 0 ELSE 1 END,
                          CASE WHEN r.category_id IS NOT NULL THEN 0 ELSE 1 END,
                          r.rule_id
               )
         WHERE ROWNUM = 1;
        RETURN v_rule;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            v_rule.rule_id := NULL;
            RETURN v_rule;
    END match_rule;


    -- 私有: 命中规则后按 rule_type 折算最终价，base 为物料标准价或规则基准
    FUNCTION apply_rule(
        p_rule_type  IN VARCHAR2,
        p_price_value IN NUMBER,
        p_base_price IN NUMBER
    ) RETURN NUMBER IS
    BEGIN
        RETURN CASE p_rule_type
            WHEN const_pkg.c_rule_list         THEN p_price_value
            WHEN const_pkg.c_rule_override     THEN p_price_value
            WHEN const_pkg.c_rule_discount_pct THEN ROUND(p_base_price * (1 - p_price_value), 6)
            WHEN const_pkg.c_rule_discount_amt THEN GREATEST(p_base_price - p_price_value, 0)
            ELSE p_base_price
        END;
    END apply_rule;


    PROCEDURE get_price_detail(
        p_item_id     IN  NUMBER,
        p_customer_id IN  NUMBER,
        p_qty         IN  NUMBER,
        p_base_price  OUT NUMBER,
        p_final_price OUT NUMBER,
        p_rule_id     OUT NUMBER,
        p_rule_type   OUT VARCHAR2
    ) IS
        v_item    t_item%ROWTYPE;
        v_list_id t_price_list.price_list_id%TYPE;
        v_rule    t_price_rule%ROWTYPE;
        v_qty     NUMBER := NVL(p_qty, 1);
        v_as_of   DATE   := util_pkg.curr_biz_date();
    BEGIN
        BEGIN
            SELECT * INTO v_item FROM t_item WHERE item_id = p_item_id;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_item_not_found, const_pkg.c_mod_price, 'get_price_detail',
                    '物料不存在 item_id=' || p_item_id, TO_CHAR(p_item_id));
        END;

        -- 基准价默认取物料标价，DISCOUNT_* 在它上面打折
        p_base_price := v_item.list_price;
        v_list_id    := pick_price_list(p_customer_id, v_as_of);
        v_rule       := match_rule(v_list_id, p_item_id, v_item.category_id,
                                   p_customer_id, v_qty, v_as_of);

        IF v_rule.rule_id IS NULL THEN
            -- 没命中: 退回标价(见包头取舍说明)
            p_rule_id     := NULL;
            p_rule_type   := NULL;
            p_final_price := p_base_price;
            RETURN;
        END IF;

        -- LIST/OVERRIDE 用规则自身价做基准展示，折扣类仍以标价为基准
        IF v_rule.rule_type IN (const_pkg.c_rule_list, const_pkg.c_rule_override) THEN
            p_base_price := v_rule.price_value;
        END IF;

        p_rule_id     := v_rule.rule_id;
        p_rule_type   := v_rule.rule_type;
        p_final_price := apply_rule(v_rule.rule_type, v_rule.price_value, v_item.list_price);
    END get_price_detail;


    FUNCTION get_price(
        p_item_id     IN NUMBER,
        p_customer_id IN NUMBER   DEFAULT NULL,
        p_qty         IN NUMBER   DEFAULT 1,
        p_as_of       IN DATE     DEFAULT NULL
    ) RETURN NUMBER IS
        v_base  NUMBER;
        v_final NUMBER;
        v_rid   NUMBER;
        v_rtype VARCHAR2(16);
    BEGIN
        -- p_as_of 目前由 get_price_detail 内部按业务日期取价; 显式传值场景留待重载扩展
        get_price_detail(p_item_id, p_customer_id, NVL(p_qty, 1),
                         v_base, v_final, v_rid, v_rtype);
        RETURN v_final;
    END get_price;


    PROCEDURE reprice_sales_order(p_so_id IN NUMBER) IS
        v_so      t_sales_order%ROWTYPE;
        v_total   NUMBER := 0;
        v_base    NUMBER;
        v_final   NUMBER;
        v_rid     NUMBER;
        v_rtype   VARCHAR2(16);
        v_disc    NUMBER;

        -- 显式游标 + for update，配合 where current of 逐行回写
        CURSOR c_line IS
            SELECT so_line_id, item_id, qty_ordered, unit_price, discount_pct
              FROM t_so_line
             WHERE so_id = p_so_id
               AND line_status <> const_pkg.c_line_cancel
               FOR UPDATE OF unit_price, discount_pct;
    BEGIN
        BEGIN
            SELECT * INTO v_so FROM t_sales_order WHERE so_id = p_so_id FOR UPDATE;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_price_list_not_found, const_pkg.c_mod_price, 'reprice_sales_order',
                    '销售单不存在 so_id=' || p_so_id, TO_CHAR(p_so_id));
        END;

        -- DRAFT/CONFIRMED 才允许重定价; 已发货行价格已锁定
        IF v_so.status NOT IN ('DRAFT', 'CONFIRMED') THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_price_rule_missing, const_pkg.c_mod_price, 'reprice_sales_order',
                '当前状态不可重定价 status=' || v_so.status, TO_CHAR(p_so_id));
        END IF;

        FOR r IN c_line LOOP
            get_price_detail(r.item_id, v_so.customer_id, r.qty_ordered,
                            v_base, v_final, v_rid, v_rtype);

            -- 把折扣额还原成折扣率落在行上(t_so_line.discount_pct 是比率，0<=x<1)
            IF v_base > 0 AND v_final < v_base THEN
                v_disc := ROUND((v_base - v_final) / v_base, 4);
            ELSE
                v_disc := 0;
            END IF;
            IF v_disc >= 1 THEN
                v_disc := 0.9999;
            END IF;

            UPDATE t_so_line
               SET unit_price   = v_base,
                   discount_pct = v_disc
             WHERE CURRENT OF c_line;

            v_total := v_total + ROUND(r.qty_ordered * v_base * (1 - v_disc), 4);
        END LOOP;

        UPDATE t_sales_order
           SET total_amount = v_total
         WHERE so_id = p_so_id;
    END reprice_sales_order;


    PROCEDURE list_effective_rules(
        p_item_id     IN  NUMBER,
        p_customer_id IN  NUMBER   DEFAULT NULL,
        p_cur         OUT SYS_REFCURSOR
    ) IS
        v_item    t_item%ROWTYPE;
        v_list_id t_price_list.price_list_id%TYPE;
        v_as_of   DATE := util_pkg.curr_biz_date();
    BEGIN
        BEGIN
            SELECT * INTO v_item FROM t_item WHERE item_id = p_item_id;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_item_not_found, const_pkg.c_mod_price, 'list_effective_rules',
                    '物料不存在 item_id=' || p_item_id, TO_CHAR(p_item_id));
        END;

        v_list_id := pick_price_list(p_customer_id, v_as_of);

        -- 分析函数 row_number(): 按真实命中排序键给序号，hit_flag=Y 即 get_price 会选中的那条
        -- 这里不加 min_qty 阶梯过滤，把整张表的候选都列出来供前端看分档，序号只标"若数量落档谁先命中"
        OPEN p_cur FOR
            SELECT r.rule_id,
                   r.price_list_id,
                   r.item_id,
                   r.category_id,
                   r.customer_id,
                   r.min_qty,
                   r.max_qty,
                   r.rule_type,
                   r.price_value,
                   r.priority,
                   ROW_NUMBER() OVER (
                       ORDER BY r.priority,
                                CASE WHEN r.item_id IS NOT NULL THEN 0 ELSE 1 END,
                                CASE WHEN r.customer_id IS NOT NULL THEN 0 ELSE 1 END,
                                CASE WHEN r.category_id IS NOT NULL THEN 0 ELSE 1 END,
                                r.rule_id
                   ) AS match_seq,
                   CASE WHEN ROW_NUMBER() OVER (
                              ORDER BY r.priority,
                                       CASE WHEN r.item_id IS NOT NULL THEN 0 ELSE 1 END,
                                       CASE WHEN r.customer_id IS NOT NULL THEN 0 ELSE 1 END,
                                       CASE WHEN r.category_id IS NOT NULL THEN 0 ELSE 1 END,
                                       r.rule_id) = 1
                        THEN 'Y' ELSE 'N' END AS hit_flag
              FROM t_price_rule r
             WHERE r.price_list_id = v_list_id
               AND r.is_active = 'Y'
               AND r.valid_from <= v_as_of
               AND (r.valid_to IS NULL OR r.valid_to >= v_as_of)
               AND (r.item_id IS NULL OR r.item_id = p_item_id)
               AND (r.category_id IS NULL OR r.category_id = v_item.category_id)
               AND (r.customer_id IS NULL OR r.customer_id = p_customer_id)
             ORDER BY match_seq;
    END list_effective_rules;

END pricing_pkg;
/
