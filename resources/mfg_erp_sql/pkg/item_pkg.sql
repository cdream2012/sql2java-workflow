-- 物料主数据 + 分类树
-- get_item_obj 按 item_type 构造对应对象子型(RAW/SEMI/FG/SVC)，返回基类引用供上层多态调用
-- 分类树操作集中走 connect by: 取路径、取子树、重算 level_no/path/is_leaf

CREATE OR REPLACE PACKAGE item_pkg AS

    -- 取物料对象: 按 item_type 实例化 t_item_obj 的子型(对象继承多态入口)
    -- 上层拿到基类引用后调 valuation_method/is_stockable/lead_time_days 走动态分派
    FUNCTION get_item_obj(p_item_id IN NUMBER) RETURN t_item_obj;

    -- 取物料行(轻量)，找不到抛 e_item_not_found
    FUNCTION get_item(p_item_id IN NUMBER) RETURN t_item%ROWTYPE;

    -- 编码查 id，重载: 既支持 item_code 也支持(类型,关键词)模糊
    FUNCTION find_item_id(p_item_code IN VARCHAR2) RETURN NUMBER;

    PROCEDURE create_item(
        p_item_code      IN  VARCHAR2,
        p_item_name      IN  VARCHAR2,
        p_item_type      IN  VARCHAR2,
        p_category_id    IN  NUMBER,
        p_base_uom       IN  VARCHAR2,
        p_std_cost       IN  NUMBER   DEFAULT 0,
        p_dim            IN  t_dimension DEFAULT NULL,
        p_tags           IN  t_tag_varray DEFAULT NULL,
        p_item_id        OUT NUMBER
    );

    -- 分类路径: connect by + sys_connect_by_path 从根拼到本节点
    FUNCTION get_category_path(p_category_id IN NUMBER) RETURN VARCHAR2;

    -- 列出某节点整棵子树(含层级/是否叶/根路径)，connect by start with ... connect by prior
    PROCEDURE list_category_subtree(
        p_root_category_id IN  NUMBER,
        p_cur              OUT SYS_REFCURSOR
    );

    -- 重算分类树的 level_no / path / is_leaf
    -- connect by 算出层级与路径后，用 merge 一次性回写(集合写)
    PROCEDURE rebuild_category_tree;

    -- 按累计消耗占比做 ABC 分类，窗口函数算累计占比后 merge 回写 t_item.abc_class
    -- 阈值取 t_app_param 的 ABC_A_PCT / ABC_B_PCT
    PROCEDURE reclassify_abc(p_from_date IN DATE, p_to_date IN DATE);

    -- 物料宽视图的 INSTEAD OF 触发器会调它把平铺字段拼回对象列后更新主表
    PROCEDURE apply_item_flat(
        p_item_id    IN NUMBER,
        p_item_name  IN VARCHAR2,
        p_std_cost   IN NUMBER,
        p_list_price IN NUMBER,
        p_status     IN VARCHAR2,
        p_length_cm  IN NUMBER,
        p_width_cm   IN NUMBER,
        p_height_cm  IN NUMBER,
        p_weight_kg  IN NUMBER
    );

END item_pkg;
/

CREATE OR REPLACE PACKAGE BODY item_pkg AS

    -- 物料主数据 + 分类树。
    -- 对象层与 t_item 的关系: 表里靠 item_type 区分料号，get_item_obj 在内存里把它实例化成
    -- 对应的 t_item_obj 子型，让上层(costing/mrp)拿基类引用走多态。分类树的 level_no/path/is_leaf
    -- 是冗余缓存列，rebuild_category_tree 用 connect by 一次算齐再 merge 回写，平时查询直接读缓存。

    FUNCTION get_item_obj(p_item_id IN NUMBER) RETURN t_item_obj IS
        v_item t_item%ROWTYPE;
        v_bom  NUMBER;
    BEGIN
        v_item := get_item(p_item_id);

        -- 多态构造: 同一行数据按 item_type 落到不同子型，半成品归到成品一类(都靠 BOM 制造、标准成本)
        -- 返回基类声明类型，调用方对 valuation_method/is_stockable/lead_time_days 的调用由运行时分派
        CASE v_item.item_type
            WHEN c_item_raw THEN
                RETURN t_raw_material_obj(
                    v_item.item_id, v_item.item_code, v_item.item_name,
                    v_item.base_uom, v_item.std_cost,
                    v_item.preferred_supplier, v_item.shelf_life_days, v_item.reorder_point);
            WHEN c_item_svc THEN
                RETURN t_service_item_obj(
                    v_item.item_id, v_item.item_code, v_item.item_name,
                    v_item.base_uom, v_item.std_cost);
            ELSE
                -- FG / SEMI: 取默认 ACTIVE BOM 头作为对象的 bom_id，没有也不报错(可能尚未建 BOM)
                BEGIN
                    SELECT bom_id INTO v_bom
                      FROM t_bom_header
                     WHERE item_id    = v_item.item_id
                       AND status     = 'ACTIVE'
                       AND is_default  = 'Y'
                       AND effective_from <= util_pkg.curr_biz_date()
                       AND (effective_to IS NULL OR effective_to >= util_pkg.curr_biz_date())
                       AND ROWNUM = 1;
                EXCEPTION
                    WHEN NO_DATA_FOUND THEN
                        v_bom := NULL;
                END;
                RETURN t_finished_good_obj(
                    v_item.item_id, v_item.item_code, v_item.item_name,
                    v_item.base_uom, v_item.std_cost,
                    v_bom, v_item.lead_time_days);
        END CASE;
    END get_item_obj;


    FUNCTION get_item(p_item_id IN NUMBER) RETURN t_item%ROWTYPE IS
        v_item t_item%ROWTYPE;
    BEGIN
        SELECT * INTO v_item FROM t_item WHERE item_id = p_item_id;
        RETURN v_item;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_item_not_found, const_pkg.c_mod_item, 'get_item',
                '物料不存在 item_id=' || p_item_id, TO_CHAR(p_item_id));
            RETURN v_item;
    END get_item;


    FUNCTION find_item_id(p_item_code IN VARCHAR2) RETURN NUMBER IS
        v_id NUMBER;
    BEGIN
        SELECT item_id INTO v_id FROM t_item WHERE item_code = p_item_code;
        RETURN v_id;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_item_not_found, const_pkg.c_mod_item, 'find_item_id',
                '物料编码不存在 code=' || p_item_code, p_item_code);
            RETURN NULL;
    END find_item_id;


    PROCEDURE create_item(
        p_item_code      IN  VARCHAR2,
        p_item_name      IN  VARCHAR2,
        p_item_type      IN  VARCHAR2,
        p_category_id    IN  NUMBER,
        p_base_uom       IN  VARCHAR2,
        p_std_cost       IN  NUMBER   DEFAULT 0,
        p_dim            IN  t_dimension DEFAULT NULL,
        p_tags           IN  t_tag_varray DEFAULT NULL,
        p_item_id        OUT NUMBER
    ) IS
    BEGIN
        IF p_item_type NOT IN (c_item_raw, c_item_semi, c_item_fg, c_item_svc) THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_item_not_found, const_pkg.c_mod_item, 'create_item',
                '非法物料类型 ' || p_item_type, p_item_code);
        END IF;

        p_item_id := seq_item_id.NEXTVAL;

        -- 服务类不入库不估值，估值方法直接钉死 NONE，其余按类型给默认(后续可在物料档案改)
        INSERT INTO t_item (
            item_id, item_code, item_name, item_type, category_id, base_uom,
            std_cost, valuation_method, dim, tags,
            created_by, created_at
        ) VALUES (
            p_item_id, p_item_code, p_item_name, p_item_type, p_category_id, p_base_uom,
            NVL(p_std_cost, 0),
            CASE p_item_type WHEN c_item_svc THEN c_val_none
                             WHEN c_item_raw THEN c_val_fifo
                             ELSE c_val_std END,
            p_dim, p_tags,
            util_pkg.get_operator(), CURRENT_TIMESTAMP
        );
    END create_item;


    FUNCTION get_category_path(p_category_id IN NUMBER) RETURN VARCHAR2 IS
        v_path VARCHAR2(500);
    BEGIN
        -- 从目标节点沿 parent 向上爬到根，再用 sys_connect_by_path 把 code 串成 /a/b/c
        -- start with 钉在根节点(parent 为空)，connect by prior 让"父在前、子在后"，路径自然从根拼起
        SELECT SYS_CONNECT_BY_PATH(category_code, '/')
          INTO v_path
          FROM t_item_category
         WHERE category_id = p_category_id
        START WITH parent_category_id IS NULL
        CONNECT BY PRIOR category_id = parent_category_id;
        RETURN v_path;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_category_not_found, const_pkg.c_mod_item, 'get_category_path',
                '分类不存在或未挂到根 category_id=' || p_category_id, TO_CHAR(p_category_id));
            RETURN NULL;
    END get_category_path;


    PROCEDURE list_category_subtree(
        p_root_category_id IN  NUMBER,
        p_cur              OUT SYS_REFCURSOR
    ) IS
    BEGIN
        OPEN p_cur FOR
            SELECT category_id,
                   parent_category_id,
                   category_code,
                   category_name,
                   LEVEL                              AS lvl,
                   CONNECT_BY_ISLEAF                  AS is_leaf_calc,
                   CONNECT_BY_ROOT category_code      AS root_code,
                   SYS_CONNECT_BY_PATH(category_code, '/') AS path
              FROM t_item_category
            START WITH category_id = p_root_category_id
            CONNECT BY PRIOR category_id = parent_category_id
             ORDER SIBLINGS BY category_code;
    END list_category_subtree;


    PROCEDURE rebuild_category_tree IS
    BEGIN
        -- connect by 整树跑一遍算出每节点的层级/根路径/是否叶，再用 merge 一次性批量回写缓存列
        -- 用 merge 而非逐行 update: 这是离线重算(导入/迁移后跑)，集合写一把过比逐行循环干净
        MERGE INTO t_item_category tgt
        USING (
            SELECT category_id,
                   LEVEL                                   AS level_no,
                   SYS_CONNECT_BY_PATH(category_code, '/') AS path,
                   CASE CONNECT_BY_ISLEAF WHEN 1 THEN 'Y' ELSE 'N' END AS is_leaf
              FROM t_item_category
            START WITH parent_category_id IS NULL
            CONNECT BY PRIOR category_id = parent_category_id
        ) src
        ON (tgt.category_id = src.category_id)
        WHEN MATCHED THEN
            UPDATE SET tgt.level_no = src.level_no,
                       tgt.path     = src.path,
                       tgt.is_leaf  = src.is_leaf;
    END rebuild_category_tree;


    PROCEDURE reclassify_abc(p_from_date IN DATE, p_to_date IN DATE) IS
        v_a_pct NUMBER := util_pkg.get_param('ABC_A_PCT', 0.80);
        v_b_pct NUMBER := util_pkg.get_param('ABC_B_PCT', 0.95);
    BEGIN
        -- 经典 ABC 帕累托: 按窗口期出库消耗金额降序排，算累计占比(到本物料为止占总消耗的比例)
        -- 落在 A 阈值内的是 A 类(少数物料占大头金额)，依次 B/C。窗口函数 sum() over(order by) 出累计，
        -- 除以全量 sum() over() 得占比。出库口径取 direction='O'(发料/生产领用/调出)的 total_cost。
        MERGE INTO t_item tgt
        USING (
            SELECT item_id,
                   CASE
                       WHEN cum_pct <= v_a_pct THEN 'A'
                       WHEN cum_pct <= v_b_pct THEN 'B'
                       ELSE 'C'
                   END AS abc_class
              FROM (
                    SELECT item_id,
                           SUM(consume_amt) OVER (ORDER BY consume_amt DESC, item_id)
                               / NULLIF(SUM(consume_amt) OVER (), 0) AS cum_pct
                      FROM (
                            SELECT item_id, SUM(total_cost) AS consume_amt
                              FROM t_inventory_txn
                             WHERE direction = const_pkg.c_dir_out
                               AND txn_date BETWEEN p_from_date AND p_to_date
                             GROUP BY item_id
                            HAVING SUM(total_cost) > 0
                           )
                   )
        ) src
        ON (tgt.item_id = src.item_id)
        WHEN MATCHED THEN
            UPDATE SET tgt.abc_class = src.abc_class,
                       tgt.updated_by = util_pkg.get_operator(),
                       tgt.updated_at = CURRENT_TIMESTAMP;
    END reclassify_abc;


    PROCEDURE apply_item_flat(
        p_item_id    IN NUMBER,
        p_item_name  IN VARCHAR2,
        p_std_cost   IN NUMBER,
        p_list_price IN NUMBER,
        p_status     IN VARCHAR2,
        p_length_cm  IN NUMBER,
        p_width_cm   IN NUMBER,
        p_height_cm  IN NUMBER,
        p_weight_kg  IN NUMBER
    ) IS
        v_dim t_dimension;
    BEGIN
        -- 视图把对象列 dim 拍成了四个平铺尺寸字段，INSTEAD OF 触发器收到平铺值后调本过程拼回对象
        -- 四个尺寸全空时整列置 null，避免存一个空壳对象
        IF p_length_cm IS NULL AND p_width_cm IS NULL
           AND p_height_cm IS NULL AND p_weight_kg IS NULL THEN
            v_dim := NULL;
        ELSE
            v_dim := t_dimension(p_length_cm, p_width_cm, p_height_cm, p_weight_kg);
        END IF;

        UPDATE t_item
           SET item_name  = p_item_name,
               std_cost   = NVL(p_std_cost, std_cost),
               list_price = NVL(p_list_price, list_price),
               status     = NVL(p_status, status),
               dim        = v_dim,
               updated_by = util_pkg.get_operator(),
               updated_at = CURRENT_TIMESTAMP
         WHERE item_id = p_item_id;

        IF SQL%ROWCOUNT = 0 THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_item_not_found, const_pkg.c_mod_item, 'apply_item_flat',
                '物料不存在 item_id=' || p_item_id, TO_CHAR(p_item_id));
        END IF;
    END apply_item_flat;

END item_pkg;
/
