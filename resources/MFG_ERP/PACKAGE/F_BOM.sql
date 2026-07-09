-- BOM 展开 / 反查 / 版本比对 / 成本卷算
-- 递归是本包主题，刻意给出三种等价展开实现压测 sql2java:
--   explode        -> connect by + pipelined，流式吐展开行
--   explode_table  -> 递归 PL/SQL 子程序(局部过程自调)，累积进嵌套表返回
--   explode_cte    -> 递归 with(recursive CTE)，返回 ref cursor
-- 虚拟件(is_phantom)展开时穿透不计为领料点；环路用 nocycle 兜底并抛 e_bom_cycle

CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE MFG_ERP.F_BOM IS
    -- Author : sql2java-workflow
    -- Created : 2026-07-03
    -- Purpose : BOM 展开 / 反查 / 版本比对 / 成本卷算 / 递归是本包主题，刻意给出三种等价展开实现压测 sql2java: / explode        -> connect by + pipelined，流式吐展开行 / explode_table  -> 递归 PL/SQL 子程序(局部过程自调)，累积进嵌套表返回 / explode_cte    -> 递归 with(recursive CTE)，返回 ref cursor / 虚拟件(is_phantom)展开时穿透不计为领料点；环路用 nocycle 兜底并抛 e_bom_cycle

    -- 取某 BOM 的当层组件为对象嵌套表(bulk collect into 对象集合)
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：取某 BOM 的当层组件为对象嵌套表(bulk collect into 对象集合)
    *****************************************************************/
    FUNCTION get_components(ii_bom_id IN NUMBER) RETURN t_bom_comp_tab;

    -- 取物料当前生效的默认 ACTIVE BOM 头 id，无则抛 e_bom_no_active
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：取物料当前生效的默认 ACTIVE BOM 头 id，无则抛 e_bom_no_active
    *****************************************************************/
    FUNCTION get_active_bom_id(ii_item_id IN NUMBER, id_as_of IN DATE DEFAULT NULL) RETURN NUMBER;

    -- 多层展开(connect by 版)，pipelined 流式返回
    -- 用 sys_connect_by_path 记路径，connect_by_isleaf 标叶子，level 记层级
    -- p_qty 为顶层需求量，cum_qty 自顶向下累乘(含损耗)
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：多层展开(connect by 版)，pipelined 流式返回 / 用 sys_connect_by_path 记路径，connect_by_isleaf 标叶子，level 记层级 / p_qty 为顶层需求量，cum_qty 自顶向下累乘(含损耗)
    *****************************************************************/
    FUNCTION explode(
        ii_item_id IN NUMBER,
        ii_qty     IN NUMBER   DEFAULT 1,
        id_as_of   IN DATE     DEFAULT NULL
    ) RETURN t_explosion_tab PIPELINED;

    -- 多层展开(递归子程序版)，结果累积进嵌套表
    -- body 内定义局部递归过程 walk(...)，每层 extend 集合并自调下钻，演示递归子程序 + 集合扩展
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：多层展开(递归子程序版)，结果累积进嵌套表 / body 内定义局部递归过程 walk(...)，每层 extend 集合并自调下钻，演示递归子程序 + 集合扩展
    *****************************************************************/
    PROCEDURE explode_table(
        ii_item_id IN  NUMBER,
        ii_qty     IN  NUMBER   DEFAULT 1,
        id_as_of   IN  DATE     DEFAULT NULL,
        ot_result  OUT t_explosion_tab
    );

    -- 多层展开(递归 CTE 版)，返回 ref cursor 供应用层流式读
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：多层展开(递归 CTE 版)，返回 ref cursor 供应用层流式读
    *****************************************************************/
    PROCEDURE explode_cte(
        ii_item_id IN  NUMBER,
        ii_qty     IN  NUMBER   DEFAULT 1,
        or_cur     OUT SYS_REFCURSOR
    );

    -- 反查: 某组件被哪些上层用到(单层 + 逐层向上 connect by)
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：反查: 某组件被哪些上层用到(单层 + 逐层向上 connect by)
    *****************************************************************/
    PROCEDURE where_used(
        ii_component_id IN  NUMBER,
        ii_max_levels   IN  NUMBER DEFAULT NULL,
        or_cur          OUT SYS_REFCURSOR
    );

    -- 版本比对: 两个 BOM 的组件差异(新增/删除/用量变更)
    -- 各自取 t_bom_comp_tab，用 multiset except 求两向差集，multiset intersect 求交集后比用量
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：版本比对: 两个 BOM 的组件差异(新增/删除/用量变更) / 各自取 t_bom_comp_tab，用 multiset except 求两向差集，multiset intersect 求交集后比用量
    *****************************************************************/
    PROCEDURE compare_versions(
        ii_bom_id_old IN  NUMBER,
        ii_bom_id_new IN  NUMBER,
        or_cur        OUT SYS_REFCURSOR
    );

    -- 标准成本卷算: 沿 BOM 树自底向上累加材料成本(递归)，返回单位成本
    -- 调用递归独立函数 fn_bom_unit_cost
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：标准成本卷算: 沿 BOM 树自底向上累加材料成本(递归)，返回单位成本 / 调用递归独立函数 fn_bom_unit_cost
    *****************************************************************/
    FUNCTION rolled_cost(ii_item_id IN NUMBER, id_as_of IN DATE DEFAULT NULL) RETURN NUMBER;

END f_bom;
