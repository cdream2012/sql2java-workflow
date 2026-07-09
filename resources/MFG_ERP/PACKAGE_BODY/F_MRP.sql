CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE BODY MFG_ERP.F_MRP AS

    -- 逐层净算时手里攥的"按物料汇总的毛需求",key=item_id
    -- 走联合数组而非临时表: 一次运行物料数有限(几千内),纯内存滚动更省往返
    TYPE t_qty_map IS TABLE OF NUMBER INDEX BY PLS_INTEGER;

    -- 低层码缓存: item_id -> low-level code,run_mrp 内一次算好供排序
    TYPE t_llc_map IS TABLE OF PLS_INTEGER INDEX BY PLS_INTEGER;

    -- 计划行批量缓冲(供 forall merge)
    TYPE t_plan_rec IS RECORD (
        item_id            NUMBER,
        warehouse_id       NUMBER,
        bucket_date        DATE,
        level_no           NUMBER,
        gross_req          NUMBER,
        scheduled_receipt  NUMBER,
        proj_on_hand       NUMBER,
        net_req            NUMBER,
        planned_order_qty  NUMBER,
        planned_order_date DATE,
        action_msg         VARCHAR2(40)
    );
    TYPE t_plan_list IS TABLE OF t_plan_rec INDEX BY PLS_INTEGER;


    -- 取物料默认仓库: MRP 不区分多仓时落到余额里在手最多的仓,没库存就给 null(留待采购/生产指定)
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：取物料默认仓库: MRP 不区分多仓时落到余额里在手最多的仓,没库存就给 null(留待采购/生产指定)
    *****************************************************************/
    FUNCTION pick_warehouse(ii_item_id IN NUMBER) RETURN NUMBER IS
        v_wh NUMBER;
    BEGIN
        SELECT warehouse_id INTO v_wh
          FROM (
                SELECT warehouse_id
                  FROM t_inventory_balance
                 WHERE item_id = ii_item_id
                 ORDER BY qty_on_hand DESC, warehouse_id
               )
         WHERE ROWNUM = 1;
        RETURN v_wh;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            RETURN NULL;
    END pick_warehouse;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：compute_low_level_codes
    *****************************************************************/
    PROCEDURE compute_low_level_codes IS
        -- 这里只演示低层码的算法本身(沿 BOM 全树下钻取每个组件出现过的最大 level)
        -- t_item 没有持久低层码列,真正净算用的低层码在 run_mrp 里就地算;此过程供运维核对/将来落列
        v_cnt NUMBER := 0;
    BEGIN
        -- 以每个有 BOM 的物料为根全展开,connect by level 即该组件相对此根的深度
        -- 跨多个根取 max,就是该物料在整个产品结构里能下沉到的最深层 = 低层码
        FOR r IN (
            SELECT component_item_id AS item_id, MAX(lvl) AS llc
              FROM (
                    SELECT bl.component_item_id, LEVEL AS lvl
                      FROM t_bom_line bl
                      JOIN t_bom_header bh ON bh.bom_id = bl.bom_id
                     WHERE bh.status = 'ACTIVE'
                     START WITH bh.item_id IN (SELECT item_id FROM t_item WHERE item_type IN ('FG','SEMI'))
                    CONNECT BY NOCYCLE PRIOR bl.component_item_id = bh.item_id
                                   AND bh.status = 'ACTIVE'
                   )
             GROUP BY component_item_id
        ) LOOP
            v_cnt := v_cnt + 1;
            NULL;  -- 无持久列可回写时此处为占位;落库版本会 update t_item set low_level_code = r.llc
        END LOOP;

        IF MFG_ERP.F_UTIL.c_trace_compile THEN
            MFG_ERP.F_EXC.debug(MFG_ERP.F_CONST.c_mod_mrp, 'compute_low_level_codes touched ' || v_cnt || ' items');
        END IF;
    END compute_low_level_codes;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：run_mrp
    *****************************************************************/
    PROCEDURE run_mrp(
        id_run_date     IN  DATE    DEFAULT NULL,
        ii_horizon_days IN  NUMBER  DEFAULT NULL,
        oi_run_id       OUT NUMBER
    ) IS
        v_run_date DATE := NVL(id_run_date, MFG_ERP.F_UTIL.curr_biz_date());
        v_horizon  NUMBER := NVL(ii_horizon_days, 90);
        v_run_no   VARCHAR2(32);
        v_horizon_end DATE;

        v_gross    t_qty_map;   -- 当前层各物料累计毛需求
        v_llc      t_llc_map;   -- 各物料低层码
        v_plans    t_plan_list;
        v_pidx     PLS_INTEGER := 0;

        v_item_set sys.odcinumberlist := sys.odcinumberlist();  -- 出现过需求的物料集
        v_max_llc  PLS_INTEGER := 0;

        v_avail    NUMBER;
        v_intransit NUMBER;
        v_net      NUMBER;
        v_lead     NUMBER;
        v_wh       NUMBER;
        v_item_cnt NUMBER := 0;
        v_plan_cnt NUMBER := 0;

        -- 把一个物料的毛需求登记进 v_gross,并记入物料集与低层码
        PROCEDURE add_demand(p_item_id IN NUMBER, p_qty IN NUMBER) IS
        BEGIN
            IF NOT v_gross.EXISTS(p_item_id) THEN
                v_gross(p_item_id) := 0;
                v_item_set.EXTEND;
                v_item_set(v_item_set.COUNT) := p_item_id;
            END IF;
            v_gross(p_item_id) := v_gross(p_item_id) + NVL(p_qty, 0);
        END add_demand;
    BEGIN
        v_run_no := MFG_ERP.F_UTIL.gen_doc_no('MRP', seq_mrp_run_id.NEXTVAL, v_run_date);
        v_run_id := seq_mrp_run_id.CURRVAL;
        oi_run_id := v_run_id;
        v_horizon_end := v_run_date + v_horizon;

        INSERT INTO t_mrp_run(
            run_id, run_no, run_date, horizon_days, bucket_type,
            status, item_count, plan_count, started_at, created_by
        ) VALUES (
            v_run_id, v_run_no, v_run_date, v_horizon, 'WEEK',
            MFG_ERP.F_CONST.c_mrp_running, 0, 0, CURRENT_TIMESTAMP, MFG_ERP.F_UTIL.get_operator()
        );

        -- 1) 顶层独立需求: 预测未来期 + 销售订单未发货行
        --    预测取窗口内、按物料汇总;销售订单取 qty_ordered - qty_shipped 的缺口
        FOR d IN (
            SELECT item_id, SUM(qty) AS qty
              FROM (
                    SELECT f.item_id, f.forecast_qty AS qty
                      FROM t_demand_forecast f
                     WHERE f.period_date BETWEEN v_run_date AND v_horizon_end
                       AND f.forecast_qty > 0
                    UNION ALL
                    SELECT sl.item_id, (sl.qty_ordered - sl.qty_shipped) AS qty
                      FROM t_so_line sl
                      JOIN t_sales_order so ON so.so_id = sl.so_id
                     WHERE sl.line_status IN ('OPEN','PARTIAL')
                       AND so.status      IN ('CONFIRMED','PARTIAL')
                       AND sl.qty_ordered > sl.qty_shipped
                       AND NVL(so.required_date, v_run_date) <= v_horizon_end
                   )
             GROUP BY item_id
        ) LOOP
            add_demand(d.item_id, d.qty);
        END LOOP;

        -- 2) 给本批所有物料定低层码(供逐层推进的排序键)
        --    顶层独立需求物料先各自记 0,展开过程中遇到更深的会被覆盖成更大值
        compute_low_level_codes;
        FOR i IN 1 .. v_item_set.COUNT LOOP
            v_llc(v_item_set(i)) := 0;
        END LOOP;

        -- 把整张产品结构的低层码合进来(独立需求物料若是别人的子件也要取深值)
        FOR r IN (
            SELECT component_item_id AS item_id, MAX(lvl) AS llc
              FROM (
                    SELECT bl.component_item_id, LEVEL AS lvl
                      FROM t_bom_line bl
                      JOIN t_bom_header bh ON bh.bom_id = bl.bom_id
                     WHERE bh.status = 'ACTIVE'
                     START WITH bh.item_id IN (SELECT item_id FROM t_item WHERE item_type IN ('FG','SEMI'))
                    CONNECT BY NOCYCLE PRIOR bl.component_item_id = bh.item_id
                                   AND bh.status = 'ACTIVE'
                   )
             GROUP BY component_item_id
        ) LOOP
            v_llc(r.item_id) := GREATEST(NVL(v_llc(r.item_id), 0), r.llc);
            IF v_llc(r.item_id) > v_max_llc THEN
                v_max_llc := v_llc(r.item_id);
            END IF;
        END LOOP;

        -- 3) 按低层码升序逐层净算: 第 L 层处理所有低层码=L 且有毛需求的物料
        --    本层算出净需求 -> 沿其 ACTIVE BOM 展开把相关需求加到子件(子件低层码必然 > L)
        FOR lvl IN 0 .. v_max_llc LOOP
            FOR i IN 1 .. v_item_set.COUNT LOOP
                DECLARE
                    v_item NUMBER := v_item_set(i);
                BEGIN
                    -- 只在物料所属层处理一次,且本层确有正毛需求
                    IF NVL(v_llc(v_item), 0) <> lvl OR NVL(v_gross(v_item), 0) <= 0 THEN
                        GOTO next_item;
                    END IF;

                    v_item_cnt := v_item_cnt + 1;
                    v_wh := pick_warehouse(v_item);

                    -- 在手可用: 有默认仓走该仓,否则跨仓汇总余额
                    IF v_wh IS NOT NULL THEN
                        v_avail := NVL(MFG_ERP.F_INVENTORY.get_available(v_item, v_wh), 0);
                    ELSE
                        SELECT NVL(SUM(qty_on_hand - qty_allocated), 0)
                          INTO v_avail
                          FROM t_inventory_balance
                         WHERE item_id = v_item;
                    END IF;

                    -- 在途: 窗口内未收完的采购订单行(qty_ordered - qty_received)
                    SELECT NVL(SUM(pl.qty_ordered - pl.qty_received), 0)
                      INTO v_intransit
                      FROM t_po_line pl
                      JOIN t_purchase_order po ON po.po_id = pl.po_id
                     WHERE pl.item_id = v_item
                       AND pl.line_status IN ('OPEN','PARTIAL')
                       AND po.status      IN ('APPROVED','PARTIAL')
                       AND NVL(pl.need_date, v_run_date) <= v_horizon_end;

                    v_net := v_gross(v_item) - v_avail - v_intransit;

                    -- 提前期倒排: 计划下单日 = 需求日 - 提前期(简化用窗口末当需求日)
                    SELECT lead_time_days INTO v_lead FROM t_item WHERE item_id = v_item;

                    v_pidx := v_pidx + 1;
                    v_plans(v_pidx).item_id           := v_item;
                    v_plans(v_pidx).warehouse_id      := v_wh;
                    v_plans(v_pidx).bucket_date       := v_horizon_end;
                    v_plans(v_pidx).level_no          := lvl;
                    v_plans(v_pidx).gross_req         := MFG_ERP.F_UTIL.round_qty(v_gross(v_item), NULL);
                    v_plans(v_pidx).scheduled_receipt := v_intransit;
                    v_plans(v_pidx).proj_on_hand      := v_avail;

                    IF v_net > 0 THEN
                        v_plans(v_pidx).net_req            := MFG_ERP.F_UTIL.round_qty(v_net, NULL);
                        v_plans(v_pidx).planned_order_qty  := MFG_ERP.F_UTIL.round_qty(v_net, NULL);
                        v_plans(v_pidx).planned_order_date := v_horizon_end - NVL(v_lead, 0);
                        v_plans(v_pidx).action_msg         := '建议下单 提前期' || NVL(v_lead, 0) || '天';

                        -- 相关需求下放: 用净需求展开 ACTIVE BOM,把每个组件的累计用量加进毛需求
                        -- explode 的 cum_qty 已是自顶向下累乘(含损耗),按净需求传 p_qty 即得各子件总用量
                        -- 虚拟件(is_phantom='Y')只是 BOM 结构层,不单独领料,跳过不计需求
                        BEGIN
                            FOR c IN (
                                SELECT component_item_id, cum_qty, is_phantom
                                  FROM TABLE(MFG_ERP.F_BOM.explode(v_item, v_net, v_run_date))
                                 WHERE lvl = 1
                            ) LOOP
                                IF NVL(c.is_phantom, 'N') <> 'Y' THEN
                                    add_demand(c.component_item_id, c.cum_qty);
                                    -- 新出现的子件补登低层码,确保后续层能处理到
                                    IF NOT v_llc.EXISTS(c.component_item_id) THEN
                                        v_llc(c.component_item_id) := lvl + 1;
                                        IF lvl + 1 > v_max_llc THEN
                                            v_max_llc := lvl + 1;
                                        END IF;
                                    END IF;
                                END IF;
                            END LOOP;
                        EXCEPTION
                            WHEN OTHERS THEN
                                -- 无 ACTIVE BOM(纯采购件)或环路: 该物料就停在采购建议,不再下放
                                IF SQLCODE NOT IN (-20203, -20202) THEN
                                    RAISE;
                                END IF;
                        END;
                    ELSE
                        v_plans(v_pidx).net_req            := 0;
                        v_plans(v_pidx).planned_order_qty  := 0;
                        v_plans(v_pidx).planned_order_date := NULL;
                        v_plans(v_pidx).action_msg         := '需求已被在手/在途覆盖';
                    END IF;

                    <<next_item>>
                    NULL;
                END;
            END LOOP;
        END LOOP;

        -- 4) 计划行 merge 进 t_mrp_plan(同一运行+物料+时段+层 视作同一计划行,重跑覆盖)
        IF v_plans.COUNT > 0 THEN
            FORALL p IN v_plans.FIRST .. v_plans.LAST
                MERGE INTO t_mrp_plan tp
                USING (
                    SELECT v_run_id              AS run_id,
                           v_plans(p).item_id    AS item_id,
                           v_plans(p).bucket_date AS bucket_date,
                           v_plans(p).level_no   AS level_no
                      FROM DUAL
                ) src
                ON (tp.run_id = src.run_id
                    AND tp.item_id = src.item_id
                    AND tp.bucket_date = src.bucket_date
                    AND tp.level_no = src.level_no)
                WHEN MATCHED THEN UPDATE SET
                    tp.warehouse_id       = v_plans(p).warehouse_id,
                    tp.gross_req          = v_plans(p).gross_req,
                    tp.scheduled_receipt  = v_plans(p).scheduled_receipt,
                    tp.proj_on_hand       = v_plans(p).proj_on_hand,
                    tp.net_req            = v_plans(p).net_req,
                    tp.planned_order_qty  = v_plans(p).planned_order_qty,
                    tp.planned_order_date = v_plans(p).planned_order_date,
                    tp.action_msg         = v_plans(p).action_msg
                WHEN NOT MATCHED THEN INSERT (
                    plan_id, run_id, item_id, warehouse_id, bucket_date, level_no,
                    gross_req, scheduled_receipt, proj_on_hand, net_req,
                    planned_order_qty, planned_order_date, action_msg
                ) VALUES (
                    seq_mrp_plan_id.NEXTVAL, v_run_id, v_plans(p).item_id, v_plans(p).warehouse_id,
                    v_plans(p).bucket_date, v_plans(p).level_no,
                    v_plans(p).gross_req, v_plans(p).scheduled_receipt, v_plans(p).proj_on_hand,
                    v_plans(p).net_req, v_plans(p).planned_order_qty,
                    v_plans(p).planned_order_date, v_plans(p).action_msg
                );
            v_plan_cnt := v_plans.COUNT;
        END IF;

        -- 5) 回写运行头统计
        UPDATE t_mrp_run
           SET status      = MFG_ERP.F_CONST.c_mrp_success,
               item_count  = v_item_cnt,
               plan_count  = v_plan_cnt,
               finished_at = CURRENT_TIMESTAMP
         WHERE run_id = v_run_id;

        MFG_ERP.F_EXC.log_error(
            is_error_code  => 'I5010',
            is_module      => MFG_ERP.F_CONST.c_mod_mrp,
            is_procedure   => 'run_mrp',
            is_error_msg   => 'MRP 完成 run=' || v_run_no || ' items=' || v_item_cnt
                          || ' plans=' || v_plan_cnt || ' max_llc=' || v_max_llc,
            is_biz_key     => TO_CHAR(v_run_id),
            is_error_level => 'INFO');
    EXCEPTION
        WHEN OTHERS THEN
            -- 主流程失败: 头置 FAILED 留痕后抛出(参 bank F_SETTLE.run_day_end)
            UPDATE t_mrp_run
               SET status = MFG_ERP.F_CONST.c_mrp_failed, finished_at = CURRENT_TIMESTAMP
             WHERE run_id = v_run_id;
            MFG_ERP.F_EXC.log_error(
                is_error_code => MFG_ERP.F_CONST.c_err_system,
                is_module     => MFG_ERP.F_CONST.c_mod_mrp,
                is_procedure  => 'run_mrp',
                is_error_msg  => 'MRP 失败: ' || SQLERRM,
                is_biz_key    => TO_CHAR(v_run_id));
            RAISE;
    END run_mrp;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：netting_detail
    *****************************************************************/
    PROCEDURE netting_detail(
        ii_run_id  IN  NUMBER,
        ii_item_id IN  NUMBER,
        or_cur     OUT SYS_REFCURSOR
    ) IS
        v_exists NUMBER;
    BEGIN
        SELECT COUNT(*) INTO v_exists FROM t_mrp_run WHERE run_id = ii_run_id;
        IF v_exists = 0 THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_mrp_run_not_found, MFG_ERP.F_CONST.c_mod_mrp, 'netting_detail',
                'MRP 运行不存在 run_id=' || ii_run_id, TO_CHAR(ii_run_id));
        END IF;

        -- 单物料沿时段桶滚动投影在手量: 期初在手 + 累计计划到货 - 累计毛需求
        -- analytic sum over (order by bucket_date) 给出每桶的滚动结余,负值即缺口
        OPEN or_cur FOR
            SELECT mp.run_id,
                   mp.item_id,
                   mp.bucket_date,
                   mp.level_no,
                   mp.gross_req,
                   mp.scheduled_receipt,
                   mp.planned_order_qty,
                   mp.proj_on_hand AS opening_on_hand,
                   mp.proj_on_hand
                     + SUM(mp.scheduled_receipt + mp.planned_order_qty - mp.gross_req)
                         OVER (ORDER BY mp.bucket_date, mp.level_no
                               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
                     AS projected_balance,
                   mp.net_req,
                   mp.planned_order_date,
                   mp.action_msg
              FROM t_mrp_plan mp
             WHERE mp.run_id  = ii_run_id
               AND mp.item_id = ii_item_id
             ORDER BY mp.bucket_date, mp.level_no;
    END netting_detail;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：release_planned_orders
    *****************************************************************/
    PROCEDURE release_planned_orders(
        ii_run_id      IN  NUMBER,
        oi_prod_count  OUT NUMBER
    ) IS
        v_exists NUMBER;
        v_prod_no VARCHAR2(32);
        v_bom_id  NUMBER;
        v_cnt     NUMBER := 0;
    BEGIN
        oi_prod_count := 0;

        SELECT COUNT(*) INTO v_exists FROM t_mrp_run WHERE run_id = ii_run_id;
        IF v_exists = 0 THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_mrp_run_not_found, MFG_ERP.F_CONST.c_mod_mrp, 'release_planned_orders',
                'MRP 运行不存在 run_id=' || ii_run_id, TO_CHAR(ii_run_id));
        END IF;

        -- 只处理有正净需求的计划行: 成品/半成品转生产工单,原材料/服务留给采购(不在此建单)
        FOR r IN (
            SELECT mp.plan_id, mp.item_id, mp.warehouse_id, mp.planned_order_qty,
                   mp.planned_order_date, i.item_type, i.lead_time_days
              FROM t_mrp_plan mp
              JOIN t_item i ON i.item_id = mp.item_id
             WHERE mp.run_id = ii_run_id
               AND mp.planned_order_qty > 0
               AND i.item_type IN (MFG_ERP.F_CONST.c_item_fg, MFG_ERP.F_CONST.c_item_semi)
             ORDER BY mp.level_no, mp.item_id
        ) LOOP
            -- 自制件取其 ACTIVE BOM 挂到工单;无 ACTIVE BOM 则记 null(后续补维护)
            BEGIN
                v_bom_id := MFG_ERP.F_BOM.get_active_bom_id(r.item_id, SYSDATE);
            EXCEPTION
                WHEN OTHERS THEN
                    v_bom_id := NULL;
            END;

            v_prod_no := MFG_ERP.F_UTIL.gen_doc_no('PRD', seq_prod_id.NEXTVAL, NVL(r.planned_order_date, SYSDATE));

            INSERT INTO t_production_order(
                prod_id, prod_no, item_id, bom_id, qty_planned,
                qty_completed, qty_scrapped, status, warehouse_id,
                start_date, due_date, source_mrp_id, created_by, created_at
            ) VALUES (
                seq_prod_id.CURRVAL, v_prod_no, r.item_id, v_bom_id, r.planned_order_qty,
                0, 0, MFG_ERP.F_CONST.c_prod_planned, r.warehouse_id,
                NVL(r.planned_order_date, SYSDATE) - NVL(r.lead_time_days, 0),
                r.planned_order_date, ii_run_id, MFG_ERP.F_UTIL.get_operator(), CURRENT_TIMESTAMP
            );

            -- 工单建好后,把计划行动作改成已转工单,留单号便于追溯
            UPDATE t_mrp_plan
               SET action_msg = '已转工单 ' || v_prod_no
             WHERE plan_id = r.plan_id;

            v_cnt := v_cnt + 1;
        END LOOP;

        oi_prod_count := v_cnt;

        MFG_ERP.F_EXC.log_error(
            is_error_code  => 'I5020',
            is_module      => MFG_ERP.F_CONST.c_mod_mrp,
            is_procedure   => 'release_planned_orders',
            is_error_msg   => '计划下达完成 run=' || ii_run_id || ' prod_orders=' || v_cnt,
            is_biz_key     => TO_CHAR(ii_run_id),
            is_error_level => 'INFO');
    END release_planned_orders;

END f_mrp;
