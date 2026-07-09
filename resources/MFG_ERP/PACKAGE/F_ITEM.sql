-- 物料主数据 + 分类树
-- get_item_obj 按 item_type 构造对应对象子型(RAW/SEMI/FG/SVC)，返回基类引用供上层多态调用
-- 分类树操作集中走 connect by: 取路径、取子树、重算 level_no/path/is_leaf

CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE MFG_ERP.F_ITEM IS
    -- Author : sql2java-workflow
    -- Created : 2026-07-03
    -- Purpose : 物料主数据 + 分类树 / get_item_obj 按 item_type 构造对应对象子型(RAW/SEMI/FG/SVC)，返回基类引用供上层多态调用 / 分类树操作集中走 connect by: 取路径、取子树、重算 level_no/path/is_leaf

    -- 取物料对象: 按 item_type 实例化 t_item_obj 的子型(对象继承多态入口)
    -- 上层拿到基类引用后调 valuation_method/is_stockable/lead_time_days 走动态分派
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：取物料对象: 按 item_type 实例化 t_item_obj 的子型(对象继承多态入口) / 上层拿到基类引用后调 valuation_method/is_stockable/lead_time_days 走动态分派
    *****************************************************************/
    FUNCTION get_item_obj(ii_item_id IN NUMBER) RETURN t_item_obj;

    -- 取物料行(轻量)，找不到抛 e_item_not_found
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：取物料行(轻量)，找不到抛 e_item_not_found
    *****************************************************************/
    FUNCTION get_item(ii_item_id IN NUMBER) RETURN t_item%ROWTYPE;

    -- 编码查 id，重载: 既支持 item_code 也支持(类型,关键词)模糊
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：编码查 id，重载: 既支持 item_code 也支持(类型,关键词)模糊
    *****************************************************************/
    FUNCTION find_item_id(is_item_code IN VARCHAR2) RETURN NUMBER;

    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：create_item
    *****************************************************************/
    PROCEDURE create_item(
        is_item_code      IN  VARCHAR2,
        is_item_name      IN  VARCHAR2,
        is_item_type      IN  VARCHAR2,
        ii_category_id    IN  NUMBER,
        is_base_uom       IN  VARCHAR2,
        ii_std_cost       IN  NUMBER   DEFAULT 0,
        it_dim            IN  t_dimension DEFAULT NULL,
        it_tags           IN  t_tag_varray DEFAULT NULL,
        oi_item_id        OUT NUMBER
    );

    -- 分类路径: connect by + sys_connect_by_path 从根拼到本节点
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：分类路径: connect by + sys_connect_by_path 从根拼到本节点
    *****************************************************************/
    FUNCTION get_category_path(ii_category_id IN NUMBER) RETURN VARCHAR2;

    -- 列出某节点整棵子树(含层级/是否叶/根路径)，connect by start with ... connect by prior
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：列出某节点整棵子树(含层级/是否叶/根路径)，connect by start with ... connect by prior
    *****************************************************************/
    PROCEDURE list_category_subtree(
        ii_root_category_id IN  NUMBER,
        or_cur              OUT SYS_REFCURSOR
    );

    -- 重算分类树的 level_no / path / is_leaf
    -- connect by 算出层级与路径后，用 merge 一次性回写(集合写)
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：重算分类树的 level_no / path / is_leaf / connect by 算出层级与路径后，用 merge 一次性回写(集合写)
    *****************************************************************/
    PROCEDURE rebuild_category_tree;

    -- 按累计消耗占比做 ABC 分类，窗口函数算累计占比后 merge 回写 t_item.abc_class
    -- 阈值取 t_app_param 的 ABC_A_PCT / ABC_B_PCT
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：按累计消耗占比做 ABC 分类，窗口函数算累计占比后 merge 回写 t_item.abc_class / 阈值取 t_app_param 的 ABC_A_PCT / ABC_B_PCT
    *****************************************************************/
    PROCEDURE reclassify_abc(id_from_date IN DATE, id_to_date IN DATE);

    -- 物料宽视图的 INSTEAD OF 触发器会调它把平铺字段拼回对象列后更新主表
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：物料宽视图的 INSTEAD OF 触发器会调它把平铺字段拼回对象列后更新主表
    *****************************************************************/
    PROCEDURE apply_item_flat(
        ii_item_id    IN NUMBER,
        is_item_name  IN VARCHAR2,
        ii_std_cost   IN NUMBER,
        ii_list_price IN NUMBER,
        is_status     IN VARCHAR2,
        ii_length_cm  IN NUMBER,
        ii_width_cm   IN NUMBER,
        ii_height_cm  IN NUMBER,
        ii_weight_kg  IN NUMBER
    );

END f_item;
