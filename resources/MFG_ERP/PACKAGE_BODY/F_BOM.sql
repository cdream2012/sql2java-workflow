CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE BODY MFG_ERP.F_BOM AS

    -- BOM 展开 / 反查 / 版本比对 / 成本卷算。
    -- 多层 BOM 是"行的组件本身又是另一物料的 BOM 头物料"形成的树，三种展开实现等价但机制不同:
    --   explode       connect by 一把查出整树结构，cum_qty 借深度优先前序遍历在 PL/SQL 端逐层累乘后 pipe 出
    --   explode_table 局部递归过程 walk 自调下钻，每层 extend 嵌套表，纯 PL/SQL 控制
    --   explode_cte   递归 with 让数据库自己迭代，cum_qty 在 CTE 里直接累乘
    -- 虚拟件(is_phantom，行级优先于物料级)不是领料点但要继续往下穿透；环路是脏数据，
    -- connect by nocycle 兜底不让查询挂死，walk 版靠 path 串里查重并抛 e_bom_cycle。

    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：BOM 展开 / 反查 / 版本比对 / 成本卷算。 / 多层 BOM 是"行的组件本身又是另一物料的 BOM 头物料"形成的树，三种展开实现等价但机制不同: / explode       connect by 一把查出整树结构，cum_qty 借深度优先前序遍历在 PL/SQL 端逐层累乘后 pipe 出 / explode_table 局部递归过程 walk 自调下钻，每层 extend 嵌套表，纯 PL/SQL 控制 / explode_cte   递归 with 让数据库自己迭代，cum_qty 在 CTE 里直接累乘 / 虚拟件(is_phantom，行级优先于物料级)不是领料点但要继续往下穿透；环路是脏数据， / connect by nocycle 兜底不让查询挂死，walk 版靠 path 串里查重并抛 e_bom_cycle。
    *****************************************************************/
    FUNCTION get_active_bom_id(ii_item_id IN NUMBER, id_as_of IN DATE DEFAULT NULL) RETURN NUMBER IS
        v_as_of DATE := NVL(id_as_of, MFG_ERP.F_UTIL.curr_biz_date());
        v_bom   NUMBER;
    BEGIN
        -- 同一时点最多一个默认 ACTIVE 版本，多个生效时取最晚生效那条兜底
        SELECT bom_id INTO v_bom
          FROM (
                SELECT bom_id
                  FROM t_bom_header
                 WHERE item_id    = ii_item_id
                   AND status     = 'ACTIVE'
                   AND is_default  = 'Y'
                   AND effective_from <= v_as_of
                   AND (effective_to IS NULL OR effective_to >= v_as_of)
                 ORDER BY effective_from DESC
               )
         WHERE ROWNUM = 1;
        RETURN v_bom;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_bom_no_active, MFG_ERP.F_CONST.c_mod_bom, 'get_active_bom_id',
                '物料无生效 ACTIVE BOM item_id=' || ii_item_id
                || ' as_of=' || TO_CHAR(v_as_of, 'YYYY-MM-DD'), TO_CHAR(ii_item_id));
            RETURN NULL;
    END get_active_bom_id;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：get_components
    *****************************************************************/
    FUNCTION get_components(ii_bom_id IN NUMBER) RETURN t_bom_comp_tab IS
        v_comps t_bom_comp_tab;
    BEGIN
        -- 当层组件直接 bulk collect 进对象嵌套表，元素只放参与"是否同一组件用量"的字段
        -- (component_item_id/qty_per/uom/scrap_rate)，便于后面 compare_versions 做 multiset 比较
        SELECT t_bom_comp_obj(l.component_item_id, i.item_code, l.qty_per, l.uom, l.scrap_rate)
          BULK COLLECT INTO v_comps
          FROM t_bom_line l
          JOIN t_item i ON i.item_id = l.component_item_id
         WHERE l.bom_id = ii_bom_id
         ORDER BY l.line_no;
        RETURN v_comps;
    END get_components;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：explode
    *****************************************************************/
    FUNCTION explode(
        ii_item_id IN NUMBER,
        ii_qty     IN NUMBER   DEFAULT 1,
        id_as_of   IN DATE     DEFAULT NULL
    ) RETURN t_explosion_tab PIPELINED IS
        v_as_of DATE := NVL(id_as_of, MFG_ERP.F_UTIL.curr_biz_date());

        -- 深度优先前序遍历下，按层缓存累计需用量: cum(lvl) = cum(lvl-1) * 本行含损耗实际用量
        -- connect by 自身没有"沿路径累乘"算子，借遍历顺序在 PL/SQL 端补上最干净
        TYPE t_cum_by_lvl IS TABLE OF NUMBER INDEX BY PLS_INTEGER;
        v_cum t_cum_by_lvl;
        v_row t_explosion_row;
        v_eff NUMBER;
    BEGIN
        v_cum(0) := NVL(ii_qty, 1);

        FOR r IN (
            SELECT LEVEL                       AS lvl,
                   h.item_id                   AS parent_item_id,
                   l.component_item_id,
                   ci.item_code                AS component_code,
                   ci.item_name                AS component_name,
                   ci.item_type,
                   l.qty_per,
                   l.uom,
                   l.scrap_rate,
                   CASE WHEN NVL(l.is_phantom, 'N') = 'Y' OR NVL(ci.is_phantom, 'N') = 'Y'
                        THEN 'Y' ELSE 'N' END   AS is_phantom,
                   connect_by_isleaf           AS leaf_flag,
                   sys_connect_by_path(ci.item_code, '/') AS path
              FROM t_bom_line l
              JOIN t_bom_header h ON h.bom_id = l.bom_id
              JOIN t_item       ci ON ci.item_id = l.component_item_id
             WHERE h.status = 'ACTIVE'
               AND h.is_default = 'Y'
               AND h.effective_from <= v_as_of
               AND (h.effective_to IS NULL OR h.effective_to >= v_as_of)
            START WITH h.item_id = ii_item_id
            CONNECT BY NOCYCLE PRIOR l.component_item_id = h.item_id
             ORDER SIBLINGS BY l.line_no
        ) LOOP
            -- 含损耗实际投料 = qty_per / (1 - scrap_rate)，scrap 已被 schema 约束在 [0,1)
            v_eff := r.qty_per / (1 - NVL(r.scrap_rate, 0));
            v_cum(r.lvl) := v_cum(r.lvl - 1) * v_eff;

            v_row := t_explosion_row(
                r.lvl, r.parent_item_id, r.component_item_id,
                r.component_code, r.component_name, r.item_type,
                r.qty_per,
                ROUND(v_cum(r.lvl), 6),
                r.uom, r.path,
                CASE r.leaf_flag WHEN 1 THEN 'Y' ELSE 'N' END,
                r.is_phantom);
            PIPE ROW(v_row);
        END LOOP;
        RETURN;
    END explode;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：explode_table
    *****************************************************************/
    PROCEDURE explode_table(
        ii_item_id IN  NUMBER,
        ii_qty     IN  NUMBER   DEFAULT 1,
        id_as_of   IN  DATE     DEFAULT NULL,
        ot_result  OUT t_explosion_tab
    ) IS
        v_as_of DATE := NVL(id_as_of, MFG_ERP.F_UTIL.curr_biz_date());

        -- 局部递归过程: 进一层就 extend 一格写结果，再对每个组件自调下钻
        -- p_path 串既做展示路径也做环路检测(组件 id 已在路径里说明绕回来了)，配合层数上限双保险
        PROCEDURE walk(
            p_parent_item IN NUMBER,
            p_cum_qty     IN NUMBER,
            p_lvl         IN NUMBER,
            p_path        IN VARCHAR2
        ) IS
            v_node_path VARCHAR2(1000);
        BEGIN
            IF p_lvl > MFG_ERP.F_CONST.c_max_bom_levels THEN
                MFG_ERP.F_EXC.raise_biz_error(
                    MFG_ERP.F_CONST.c_err_bom_cycle, MFG_ERP.F_CONST.c_mod_bom, 'explode_table',
                    'BOM 层级超上限 ' || MFG_ERP.F_CONST.c_max_bom_levels
                    || '，疑似环路 path=' || p_path, TO_CHAR(p_parent_item));
            END IF;

            FOR r IN (
                SELECT l.component_item_id,
                       ci.item_code,
                       ci.item_name,
                       ci.item_type,
                       l.qty_per,
                       l.uom,
                       l.scrap_rate,
                       CASE WHEN NVL(l.is_phantom, 'N') = 'Y' OR NVL(ci.is_phantom, 'N') = 'Y'
                            THEN 'Y' ELSE 'N' END AS is_phantom
                  FROM t_bom_line   l
                  JOIN t_bom_header h  ON h.bom_id   = l.bom_id
                  JOIN t_item       ci ON ci.item_id = l.component_item_id
                 WHERE h.item_id    = p_parent_item
                   AND h.status     = 'ACTIVE'
                   AND h.is_default  = 'Y'
                   AND h.effective_from <= v_as_of
                   AND (h.effective_to IS NULL OR h.effective_to >= v_as_of)
                 ORDER BY l.line_no
            ) LOOP
                -- 环路检测: 同一组件已经在当前下钻路径上，再出现就是 A->B->A 这类脏数据
                IF INSTR(p_path, '/' || r.component_item_id || '/') > 0 THEN
                    MFG_ERP.F_EXC.raise_biz_error(
                        MFG_ERP.F_CONST.c_err_bom_cycle, MFG_ERP.F_CONST.c_mod_bom, 'explode_table',
                        'BOM 环路 component_id=' || r.component_item_id
                        || ' path=' || p_path, TO_CHAR(r.component_item_id));
                END IF;

                v_node_path := p_path || r.component_item_id || '/';

                ot_result.EXTEND;
                ot_result(ot_result.COUNT) := t_explosion_row(
                    p_lvl,
                    p_parent_item,
                    r.component_item_id,
                    r.item_code,
                    r.item_name,
                    r.item_type,
                    r.qty_per,
                    ROUND(p_cum_qty * (r.qty_per / (1 - NVL(r.scrap_rate, 0))), 6),
                    r.uom,
                    v_node_path,
                    'N',   -- 是否叶先置 N，下钻后无子行的回填见下
                    r.is_phantom);

                walk(
                    p_parent_item => r.component_item_id,
                    p_cum_qty     => p_cum_qty * (r.qty_per / (1 - NVL(r.scrap_rate, 0))),
                    p_lvl         => p_lvl + 1,
                    p_path        => v_node_path);

                -- 下钻没产生新行说明本组件是叶子(无下层 BOM)，回填叶标志
                IF ot_result(ot_result.COUNT).component_item_id = r.component_item_id THEN
                    ot_result(ot_result.COUNT).is_leaf := 'Y';
                END IF;
            END LOOP;
        END walk;
    BEGIN
        ot_result := t_explosion_tab();
        -- 根的路径用 /item_id/ 起头，方便子层 instr 查重
        walk(ii_item_id, NVL(ii_qty, 1), 1, '/' || ii_item_id || '/');
    END explode_table;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：explode_cte
    *****************************************************************/
    PROCEDURE explode_cte(
        ii_item_id IN  NUMBER,
        ii_qty     IN  NUMBER   DEFAULT 1,
        or_cur     OUT SYS_REFCURSOR
    ) IS
        v_as_of DATE := MFG_ERP.F_UTIL.curr_biz_date();
    BEGIN
        -- 递归 with: 锚成员是顶层物料的当层组件，递归成员把上一层组件当作下一层 BOM 的头物料续接
        -- cum_qty 在递归里直接累乘(上层 cum * 本行含损耗用量)，路径与层级一并在 CTE 内维护
        OPEN or_cur FOR
            WITH bom_tree (
                lvl, parent_item_id, component_item_id, component_code,
                component_name, item_type, qty_per, cum_qty, uom, path, is_phantom
            ) AS (
                SELECT 1,
                       h.item_id,
                       l.component_item_id,
                       ci.item_code,
                       ci.item_name,
                       ci.item_type,
                       l.qty_per,
                       ROUND(NVL(ii_qty, 1) * (l.qty_per / (1 - NVL(l.scrap_rate, 0))), 6),
                       l.uom,
                       '/' || ci.item_code,
                       CASE WHEN NVL(l.is_phantom, 'N') = 'Y' OR NVL(ci.is_phantom, 'N') = 'Y'
                            THEN 'Y' ELSE 'N' END
                  FROM t_bom_line   l
                  JOIN t_bom_header h  ON h.bom_id   = l.bom_id
                  JOIN t_item       ci ON ci.item_id = l.component_item_id
                 WHERE h.item_id    = ii_item_id
                   AND h.status     = 'ACTIVE'
                   AND h.is_default  = 'Y'
                   AND h.effective_from <= v_as_of
                   AND (h.effective_to IS NULL OR h.effective_to >= v_as_of)
                UNION ALL
                SELECT t.lvl + 1,
                       h.item_id,
                       l.component_item_id,
                       ci.item_code,
                       ci.item_name,
                       ci.item_type,
                       l.qty_per,
                       ROUND(t.cum_qty * (l.qty_per / (1 - NVL(l.scrap_rate, 0))), 6),
                       l.uom,
                       t.path || '/' || ci.item_code,
                       CASE WHEN NVL(l.is_phantom, 'N') = 'Y' OR NVL(ci.is_phantom, 'N') = 'Y'
                            THEN 'Y' ELSE 'N' END
                  FROM bom_tree     t
                  JOIN t_bom_header h  ON h.item_id   = t.component_item_id
                  JOIN t_bom_line   l  ON l.bom_id    = h.bom_id
                  JOIN t_item       ci ON ci.item_id  = l.component_item_id
                 WHERE h.status     = 'ACTIVE'
                   AND h.is_default  = 'Y'
                   AND h.effective_from <= v_as_of
                   AND (h.effective_to IS NULL OR h.effective_to >= v_as_of)
                   AND t.lvl < MFG_ERP.F_CONST.c_max_bom_levels
            )
            SELECT lvl,
                   parent_item_id,
                   component_item_id,
                   component_code,
                   component_name,
                   item_type,
                   qty_per,
                   cum_qty,
                   uom,
                   path,
                   is_phantom
              FROM bom_tree
             ORDER BY path;
    END explode_cte;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：where_used
    *****************************************************************/
    PROCEDURE where_used(
        ii_component_id IN  NUMBER,
        ii_max_levels   IN  NUMBER DEFAULT NULL,
        or_cur          OUT SYS_REFCURSOR
    ) IS
        v_as_of DATE := MFG_ERP.F_UTIL.curr_biz_date();
    BEGIN
        -- 反查("用在哪"): 从用到本组件的 BOM 行起步，沿 prior 向上爬父项，直到无人再用它
        -- 与正向展开方向相反: 这里 prior 把"子(本层头物料)"连到"父(上层组件)"
        OPEN or_cur FOR
            SELECT LEVEL                          AS lvl,
                   h.item_id                      AS parent_item_id,
                   pi.item_code                   AS parent_code,
                   pi.item_name                   AS parent_name,
                   l.component_item_id,
                   l.qty_per,
                   l.uom,
                   connect_by_isleaf              AS is_top,
                   sys_connect_by_path(pi.item_code, '<-') AS use_path
              FROM t_bom_line   l
              JOIN t_bom_header h  ON h.bom_id   = l.bom_id
              JOIN t_item       pi ON pi.item_id = h.item_id
             WHERE h.status     = 'ACTIVE'
               AND h.effective_from <= v_as_of
               AND (h.effective_to IS NULL OR h.effective_to >= v_as_of)
               AND (ii_max_levels IS NULL OR LEVEL <= ii_max_levels)
            START WITH l.component_item_id = ii_component_id
            CONNECT BY NOCYCLE PRIOR h.item_id = l.component_item_id
             ORDER SIBLINGS BY h.item_id;
    END where_used;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：compare_versions
    *****************************************************************/
    PROCEDURE compare_versions(
        ii_bom_id_old IN  NUMBER,
        ii_bom_id_new IN  NUMBER,
        or_cur        OUT SYS_REFCURSOR
    ) IS
        v_old t_bom_comp_tab;
        v_new t_bom_comp_tab;
    BEGIN
        v_old := get_components(ii_bom_id_old);
        v_new := get_components(ii_bom_id_new);

        -- 对象相等性按全属性逐一比，qty_per 改过的组件会同时落进两个差集，所以分类不能只看差集:
        --   ADDED   组件 id 在 new 的差集里、且整个 old 里都没这个 id  -> 真新增
        --   REMOVED 组件 id 在 old 的差集里、且整个 new 里都没这个 id  -> 真删除
        --   QTY_CHANGED 两版都有该 id(multiset intersect 取按 id 配得上的交集)但 qty_per 不同
        -- multiset except 求两向差集、multiset intersect 求交集，table(...) 把集合拆成行后再配对
        OPEN or_cur FOR
            WITH old_set AS (
                SELECT component_item_id, component_code, qty_per, uom, scrap_rate
                  FROM TABLE(v_old)
            ),
            new_set AS (
                SELECT component_item_id, component_code, qty_per, uom, scrap_rate
                  FROM TABLE(v_new)
            ),
            added AS (
                SELECT component_item_id, component_code, qty_per, uom
                  FROM TABLE(v_new MULTISET EXCEPT v_old)
            ),
            removed AS (
                SELECT component_item_id, component_code, qty_per, uom
                  FROM TABLE(v_old MULTISET EXCEPT v_new)
            ),
            unchanged AS (
                -- multiset intersect 取两版逐属性全等的行，这些是没动过的组件
                -- 用它把"用量变了的"从"两版都有该 id"里反向择出来: 在两版都有但不在全等交集里
                SELECT s.component_item_id
                  FROM TABLE(v_old MULTISET INTERSECT v_new) s
            )
            SELECT 'ADDED'  AS change_type,
                   a.component_item_id,
                   a.component_code,
                   TO_NUMBER(NULL)  AS old_qty_per,
                   a.qty_per         AS new_qty_per,
                   a.uom
              FROM added a
             WHERE NOT EXISTS (SELECT 1 FROM old_set o WHERE o.component_item_id = a.component_item_id)
            UNION ALL
            SELECT 'REMOVED',
                   r.component_item_id,
                   r.component_code,
                   r.qty_per,
                   TO_NUMBER(NULL),
                   r.uom
              FROM removed r
             WHERE NOT EXISTS (SELECT 1 FROM new_set n WHERE n.component_item_id = r.component_item_id)
            UNION ALL
            SELECT 'QTY_CHANGED',
                   o.component_item_id,
                   o.component_code,
                   o.qty_per,
                   n.qty_per,
                   n.uom
              FROM old_set o
              JOIN new_set n ON n.component_item_id = o.component_item_id
             WHERE o.qty_per <> n.qty_per
               AND o.component_item_id NOT IN (SELECT component_item_id FROM unchanged)
             ORDER BY change_type, component_item_id;
    END compare_versions;


    -- 私有递归: 自底向上卷算单位成本。叶子(无下层 BOM 或服务/原料)用 t_item.std_cost，
    -- 中间件(有 BOM)= sum(每个组件单位成本 * 含损耗用量) / base_qty。
    -- 刻意做成包内私有函数而非独立 standalone function: install 时独立函数在包之后才加载，
    -- rolled_cost 编译期就要能引用到它，放包内最稳。
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：私有递归: 自底向上卷算单位成本。叶子(无下层 BOM 或服务/原料)用 t_item.std_cost， / 中间件(有 BOM)= sum(每个组件单位成本 * 含损耗用量) / base_qty。 / 刻意做成包内私有函数而非独立 standalone function: install 时独立函数在包之后才加载， / rolled_cost 编译期就要能引用到它，放包内最稳。
    *****************************************************************/
    FUNCTION unit_cost(ii_item_id IN NUMBER, id_as_of IN DATE, ii_depth IN NUMBER) RETURN NUMBER IS
        v_bom   NUMBER;
        v_base  NUMBER;
        v_total NUMBER := 0;
    BEGIN
        IF ii_depth > MFG_ERP.F_CONST.c_max_bom_levels THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_bom_cycle, MFG_ERP.F_CONST.c_mod_bom, 'rolled_cost',
                '卷算层级超上限，疑似环路 item_id=' || ii_item_id, TO_CHAR(ii_item_id));
        END IF;

        BEGIN
            SELECT bom_id, base_qty INTO v_bom, v_base
              FROM (
                    SELECT bom_id, base_qty
                      FROM t_bom_header
                     WHERE item_id    = ii_item_id
                       AND status     = 'ACTIVE'
                       AND is_default  = 'Y'
                       AND effective_from <= id_as_of
                       AND (effective_to IS NULL OR effective_to >= id_as_of)
                     ORDER BY effective_from DESC
                   )
             WHERE ROWNUM = 1;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                -- 没有可制造的 BOM，就是采购/服务的叶子件，成本取标准成本
                SELECT std_cost INTO v_total FROM t_item WHERE item_id = ii_item_id;
                RETURN v_total;
        END;

        FOR r IN (SELECT component_item_id, qty_per, scrap_rate
                    FROM t_bom_line WHERE bom_id = v_bom) LOOP
            v_total := v_total
                + unit_cost(r.component_item_id, id_as_of, ii_depth + 1)
                  * (r.qty_per / (1 - NVL(r.scrap_rate, 0)));
        END LOOP;

        -- 行用量是相对 base_qty 的产出，折回单位产出成本
        RETURN ROUND(v_total / NVL(NULLIF(v_base, 0), 1), 6);
    END unit_cost;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：rolled_cost
    *****************************************************************/
    FUNCTION rolled_cost(ii_item_id IN NUMBER, id_as_of IN DATE DEFAULT NULL) RETURN NUMBER IS
    BEGIN
        RETURN unit_cost(ii_item_id, NVL(id_as_of, MFG_ERP.F_UTIL.curr_biz_date()), 1);
    END rolled_cost;

END f_bom;
