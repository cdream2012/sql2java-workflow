CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE BODY MFG_ERP.F_PROCUREMENT AS

    -- PO 状态机: DRAFT -> APPROVED -> PARTIAL -> RECEIVED -> CLOSED，旁路 CANCELLED
    -- 头状态是行状态的汇总投影: 收货时先算行状态(满->CLOSED/部分->PARTIAL)，再回推头状态
    -- 收货过账委托 MFG_ERP.F_INVENTORY.receive_stock，库存与 qty_received 必须同事务，避免账实不符

    -- 私有: 锁单头并校验存在，返回 rowtype 供调用方复用
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：PO 状态机: DRAFT -> APPROVED -> PARTIAL -> RECEIVED -> CLOSED，旁路 CANCELLED / 头状态是行状态的汇总投影: 收货时先算行状态(满->CLOSED/部分->PARTIAL)，再回推头状态 / 收货过账委托 MFG_ERP.F_INVENTORY.receive_stock，库存与 qty_received 必须同事务，避免账实不符 / 私有: 锁单头并校验存在，返回 rowtype 供调用方复用
    *****************************************************************/
    FUNCTION lock_po(ii_po_id IN NUMBER, is_proc IN VARCHAR2) RETURN t_purchase_order%ROWTYPE IS
        v_po t_purchase_order%ROWTYPE;
    BEGIN
        SELECT * INTO v_po FROM t_purchase_order WHERE po_id = ii_po_id FOR UPDATE;
        RETURN v_po;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_po_not_found, MFG_ERP.F_CONST.c_mod_procure, is_proc,
                'PO 不存在 po_id=' || ii_po_id, TO_CHAR(ii_po_id));
    END lock_po;


    -- 私有: 收货后按行状态汇总回推头状态
    -- 任一行未收满则头 PARTIAL; 全部 CLOSED/CANCELLED 且至少收过货则头 RECEIVED
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：私有: 收货后按行状态汇总回推头状态 / 任一行未收满则头 PARTIAL; 全部 CLOSED/CANCELLED 且至少收过货则头 RECEIVED
    *****************************************************************/
    PROCEDURE refresh_po_header_status(ii_po_id IN NUMBER) IS
        v_open_or_partial NUMBER;
        v_any_received    NUMBER;
    BEGIN
        SELECT COUNT(CASE WHEN line_status IN (MFG_ERP.F_CONST.c_line_open, MFG_ERP.F_CONST.c_line_partial)
                          THEN 1 END),
               COUNT(CASE WHEN qty_received > 0 THEN 1 END)
          INTO v_open_or_partial, v_any_received
          FROM t_po_line
         WHERE po_id = ii_po_id
           AND line_status <> MFG_ERP.F_CONST.c_line_cancel;

        IF v_open_or_partial > 0 THEN
            -- 还有未收满的行: 只要收过一点就是 PARTIAL，否则停在 APPROVED
            UPDATE t_purchase_order
               SET status = CASE WHEN v_any_received > 0
                                 THEN MFG_ERP.F_CONST.c_po_partial
                                 ELSE MFG_ERP.F_CONST.c_po_approved END
             WHERE po_id = ii_po_id
               AND status NOT IN (MFG_ERP.F_CONST.c_po_cancelled, MFG_ERP.F_CONST.c_po_closed);
        ELSE
            -- 所有有效行收满: 头进 RECEIVED(留 RECEIVED->CLOSED 给后续对账/入账动作)
            UPDATE t_purchase_order
               SET status = MFG_ERP.F_CONST.c_po_received
             WHERE po_id = ii_po_id
               AND status NOT IN (MFG_ERP.F_CONST.c_po_cancelled, MFG_ERP.F_CONST.c_po_closed);
        END IF;
    END refresh_po_header_status;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：create_po
    *****************************************************************/
    PROCEDURE create_po(
        ii_supplier_id   IN  NUMBER,
        ii_warehouse_id  IN  NUMBER,
        id_expected_date IN  DATE,
        oi_po_id         OUT NUMBER,
        os_po_no         OUT VARCHAR2
    ) IS
        v_sup_status t_supplier.status%TYPE;
        v_id         t_purchase_order.po_id%TYPE;
        v_no         t_purchase_order.po_no%TYPE;
    BEGIN
        BEGIN
            SELECT status INTO v_sup_status
              FROM t_supplier WHERE supplier_id = ii_supplier_id;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                MFG_ERP.F_EXC.raise_biz_error(
                    MFG_ERP.F_CONST.c_err_po_not_found, MFG_ERP.F_CONST.c_mod_procure, 'create_po',
                    '供应商不存在 supplier_id=' || ii_supplier_id, TO_CHAR(ii_supplier_id));
        END;

        -- 冻结供应商不允许建单(审核环节还会再查一次，这里早拦省得建废单)
        IF v_sup_status = 'BLOCKED' THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_supplier_blocked, MFG_ERP.F_CONST.c_mod_procure, 'create_po',
                '供应商已冻结 supplier_id=' || ii_supplier_id, TO_CHAR(ii_supplier_id));
        END IF;

        v_id := seq_po_id.NEXTVAL;
        v_no := MFG_ERP.F_UTIL.gen_doc_no('PO', v_id);

        INSERT INTO t_purchase_order(
            po_id, po_no, supplier_id, order_date, expected_date,
            status, currency_code, total_amount, warehouse_id, created_by, created_at
        ) VALUES (
            v_id, v_no, ii_supplier_id, MFG_ERP.F_UTIL.curr_biz_date(), id_expected_date,
            MFG_ERP.F_CONST.c_po_draft, MFG_ERP.F_CONST.c_default_currency, 0, ii_warehouse_id,
            MFG_ERP.F_UTIL.get_operator(), CURRENT_TIMESTAMP
        );

        oi_po_id := v_id;
        os_po_no := v_no;
    END create_po;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：add_po_line
    *****************************************************************/
    PROCEDURE add_po_line(
        ii_po_id       IN NUMBER,
        ii_item_id     IN NUMBER,
        ii_qty         IN NUMBER,
        ii_unit_price  IN NUMBER,
        is_uom         IN VARCHAR2 DEFAULT NULL,
        id_need_date   IN DATE     DEFAULT NULL
    ) IS
        v_po       t_purchase_order%ROWTYPE;
        v_uom      t_item.base_uom%TYPE;
        v_next_ln  t_po_line.line_no%TYPE;
    BEGIN
        IF ii_qty IS NULL OR ii_qty <= 0 THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_po_status_invalid, MFG_ERP.F_CONST.c_mod_procure, 'add_po_line',
                '采购数量必须 > 0', TO_CHAR(ii_po_id));
        END IF;

        v_po := lock_po(ii_po_id, 'add_po_line');

        -- 只有草稿单能继续加行，已审/已收的单要改得先撤回
        IF v_po.status <> MFG_ERP.F_CONST.c_po_draft THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_po_status_invalid, MFG_ERP.F_CONST.c_mod_procure, 'add_po_line',
                '仅草稿单可加行 status=' || v_po.status, TO_CHAR(ii_po_id));
        END IF;

        -- 未传单位时取物料基本单位
        BEGIN
            SELECT base_uom INTO v_uom FROM t_item WHERE item_id = ii_item_id;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                MFG_ERP.F_EXC.raise_biz_error(
                    MFG_ERP.F_CONST.c_err_item_not_found, MFG_ERP.F_CONST.c_mod_procure, 'add_po_line',
                    '物料不存在 item_id=' || ii_item_id, TO_CHAR(ii_item_id));
        END;
        v_uom := NVL(is_uom, v_uom);

        SELECT NVL(MAX(line_no), 0) + 10 INTO v_next_ln
          FROM t_po_line WHERE po_id = ii_po_id;

        INSERT INTO t_po_line(
            po_line_id, po_id, line_no, item_id, qty_ordered, qty_received,
            unit_price, uom, need_date, line_status
        ) VALUES (
            seq_po_line_id.NEXTVAL, ii_po_id, v_next_ln, ii_item_id, ii_qty, 0,
            ii_unit_price, v_uom, id_need_date, MFG_ERP.F_CONST.c_line_open
        );

        -- 头金额随行变动累加
        UPDATE t_purchase_order
           SET total_amount = total_amount + ROUND(ii_qty * ii_unit_price, 4)
         WHERE po_id = ii_po_id;
    END add_po_line;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：approve_po
    *****************************************************************/
    PROCEDURE approve_po(ii_po_id IN NUMBER) IS
        v_po         t_purchase_order%ROWTYPE;
        v_sup_status t_supplier.status%TYPE;
        v_line_cnt   NUMBER;
    BEGIN
        v_po := lock_po(ii_po_id, 'approve_po');

        IF v_po.status = MFG_ERP.F_CONST.c_po_approved THEN
            RETURN;  -- 已审，幂等
        END IF;
        IF v_po.status <> MFG_ERP.F_CONST.c_po_draft THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_po_status_invalid, MFG_ERP.F_CONST.c_mod_procure, 'approve_po',
                '仅草稿单可审核 status=' || v_po.status, TO_CHAR(ii_po_id));
        END IF;

        SELECT COUNT(*) INTO v_line_cnt FROM t_po_line
         WHERE po_id = ii_po_id AND line_status <> MFG_ERP.F_CONST.c_line_cancel;
        IF v_line_cnt = 0 THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_po_status_invalid, MFG_ERP.F_CONST.c_mod_procure, 'approve_po',
                '空单不可审核 po_id=' || ii_po_id, TO_CHAR(ii_po_id));
        END IF;

        SELECT status INTO v_sup_status
          FROM t_supplier WHERE supplier_id = v_po.supplier_id;
        IF v_sup_status = 'BLOCKED' THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_supplier_blocked, MFG_ERP.F_CONST.c_mod_procure, 'approve_po',
                '供应商已冻结不可审核 supplier_id=' || v_po.supplier_id, TO_CHAR(ii_po_id));
        END IF;

        UPDATE t_purchase_order
           SET status      = MFG_ERP.F_CONST.c_po_approved,
               approved_by = MFG_ERP.F_UTIL.get_operator(),
               approved_at = CURRENT_TIMESTAMP
         WHERE po_id = ii_po_id;
    END approve_po;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：receive_po_line
    *****************************************************************/
    PROCEDURE receive_po_line(
        ii_po_id     IN NUMBER,
        ii_line_no   IN NUMBER,
        ii_qty       IN NUMBER,
        ii_unit_cost IN NUMBER DEFAULT NULL
    ) IS
        v_po        t_purchase_order%ROWTYPE;
        v_line      t_po_line%ROWTYPE;
        v_new_recv  NUMBER;
        v_cost      NUMBER;
        v_lot_id    NUMBER;
        v_txn_id    NUMBER;
        v_new_stat  t_po_line.line_status%TYPE;
    BEGIN
        IF ii_qty IS NULL OR ii_qty <= 0 THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_po_status_invalid, MFG_ERP.F_CONST.c_mod_procure, 'receive_po_line',
                '收货数量必须 > 0', TO_CHAR(ii_po_id));
        END IF;

        v_po := lock_po(ii_po_id, 'receive_po_line');

        -- 只有已审/部分收的单能继续收货
        IF v_po.status NOT IN (MFG_ERP.F_CONST.c_po_approved, MFG_ERP.F_CONST.c_po_partial) THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_po_status_invalid, MFG_ERP.F_CONST.c_mod_procure, 'receive_po_line',
                '当前状态不可收货 status=' || v_po.status, TO_CHAR(ii_po_id));
        END IF;

        BEGIN
            SELECT * INTO v_line FROM t_po_line
             WHERE po_id = ii_po_id AND line_no = ii_line_no FOR UPDATE;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                MFG_ERP.F_EXC.raise_biz_error(
                    MFG_ERP.F_CONST.c_err_po_not_found, MFG_ERP.F_CONST.c_mod_procure, 'receive_po_line',
                    'PO 行不存在 po_id=' || ii_po_id || ' line=' || ii_line_no, TO_CHAR(ii_po_id));
        END;

        IF v_line.line_status IN (MFG_ERP.F_CONST.c_line_closed, MFG_ERP.F_CONST.c_line_cancel) THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_po_status_invalid, MFG_ERP.F_CONST.c_mod_procure, 'receive_po_line',
                '行已关闭/取消不可收货 line_status=' || v_line.line_status, TO_CHAR(ii_po_id));
        END IF;

        -- 超收拦截: 累计收货不得超过订货量
        v_new_recv := v_line.qty_received + ii_qty;
        IF v_new_recv > v_line.qty_ordered THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_po_over_receipt, MFG_ERP.F_CONST.c_mod_procure, 'receive_po_line',
                '超收 ordered=' || v_line.qty_ordered || ' received=' || v_line.qty_received
                || ' now=' || ii_qty, TO_CHAR(ii_po_id));
        END IF;

        -- 入库成本缺省取采购单价
        v_cost := NVL(ii_unit_cost, v_line.unit_price);

        -- 过账入库: 库存与 PO 行同事务，F_INVENTORY 负责建批次/写流水/同步余额
        MFG_ERP.F_INVENTORY.receive_stock(
            ii_item_id      => v_line.item_id,
            ii_warehouse_id => v_po.warehouse_id,
            ii_qty          => ii_qty,
            ii_unit_cost    => v_cost,
            is_lot_no       => NULL,
            is_ref_doc_type => 'PO',
            ii_ref_doc_id   => ii_po_id,
            oi_lot_id       => v_lot_id,
            oi_txn_id       => v_txn_id);

        -- 行状态机: 收满 CLOSED，部分 PARTIAL
        IF v_new_recv >= v_line.qty_ordered THEN
            v_new_stat := MFG_ERP.F_CONST.c_line_closed;
        ELSE
            v_new_stat := MFG_ERP.F_CONST.c_line_partial;
        END IF;

        UPDATE t_po_line
           SET qty_received = v_new_recv,
               line_status  = v_new_stat
         WHERE po_line_id = v_line.po_line_id;

        -- 行变动后回推头状态
        refresh_po_header_status(ii_po_id);
    END receive_po_line;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：create_po_from_mrp
    *****************************************************************/
    PROCEDURE create_po_from_mrp(
        ii_run_id   IN  NUMBER,
        oi_po_count OUT NUMBER
    ) IS
        -- 一次 MRP 运行可能产出几百上千条计划行，按供应商归并后 bulk 建行
        TYPE t_plan_tab IS TABLE OF t_mrp_plan%ROWTYPE INDEX BY PLS_INTEGER;
        v_plans   t_plan_tab;

        v_run_status t_mrp_run.status%TYPE;
        v_supplier   t_item.preferred_supplier%TYPE;
        v_prev_sup   t_item.preferred_supplier%TYPE := -1;
        v_po_id      NUMBER;
        v_po_no      VARCHAR2(32);
        v_uom        t_item.base_uom%TYPE;
        v_price      NUMBER;
        v_line_no    NUMBER;
        v_as_of      DATE := MFG_ERP.F_UTIL.curr_biz_date();
    BEGIN
        oi_po_count := 0;

        BEGIN
            SELECT status INTO v_run_status FROM t_mrp_run WHERE run_id = ii_run_id;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                MFG_ERP.F_EXC.raise_biz_error(
                    MFG_ERP.F_CONST.c_err_mrp_run_not_found, MFG_ERP.F_CONST.c_mod_procure, 'create_po_from_mrp',
                    'MRP 运行不存在 run_id=' || ii_run_id, TO_CHAR(ii_run_id));
        END;
        IF v_run_status = MFG_ERP.F_CONST.c_mrp_running THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_mrp_running, MFG_ERP.F_CONST.c_mod_procure, 'create_po_from_mrp',
                'MRP 仍在运行，待完成再转单 run_id=' || ii_run_id, TO_CHAR(ii_run_id));
        END IF;

        -- 只取下单建议(planned_order_qty>0)的原材料，按供应商排序好做归并
        -- preferred_supplier 为空的物料没法定供应商，跳过并告警
        SELECT p.*
          BULK COLLECT INTO v_plans
          FROM t_mrp_plan p
          JOIN t_item i ON i.item_id = p.item_id
         WHERE p.run_id = ii_run_id
           AND p.planned_order_qty > 0
           AND i.item_type = MFG_ERP.F_CONST.c_item_raw
           AND i.preferred_supplier IS NOT NULL
         ORDER BY i.preferred_supplier, p.item_id;

        IF v_plans.COUNT = 0 THEN
            RETURN;
        END IF;

        FOR i IN v_plans.FIRST .. v_plans.LAST LOOP
            SELECT preferred_supplier, base_uom
              INTO v_supplier, v_uom
              FROM t_item WHERE item_id = v_plans(i).item_id;

            -- 供应商换组 -> 起一张新 PO 头
            IF v_supplier <> v_prev_sup THEN
                create_po(
                    ii_supplier_id   => v_supplier,
                    ii_warehouse_id  => v_plans(i).warehouse_id,
                    id_expected_date => v_plans(i).planned_order_date,
                    oi_po_id         => v_po_id,
                    os_po_no         => v_po_no);
                oi_po_count := oi_po_count + 1;
                v_prev_sup := v_supplier;
                v_line_no  := 0;
            END IF;

            -- 采购单价取标准成本兜底(MRP 不带价，正式价由审核前人工/合同价覆盖)
            SELECT NVL(std_cost, 0) INTO v_price FROM t_item WHERE item_id = v_plans(i).item_id;

            v_line_no := v_line_no + 10;
            INSERT INTO t_po_line(
                po_line_id, po_id, line_no, item_id, qty_ordered, qty_received,
                unit_price, uom, need_date, line_status
            ) VALUES (
                seq_po_line_id.NEXTVAL, v_po_id, v_line_no, v_plans(i).item_id,
                v_plans(i).planned_order_qty, 0,
                v_price, v_uom, v_plans(i).planned_order_date, MFG_ERP.F_CONST.c_line_open
            );

            UPDATE t_purchase_order
               SET total_amount = total_amount + ROUND(v_plans(i).planned_order_qty * v_price, 4)
             WHERE po_id = v_po_id;
        END LOOP;

        MFG_ERP.F_EXC.log_error(
            is_error_code  => 'I6010',
            is_module      => MFG_ERP.F_CONST.c_mod_procure,
            is_procedure   => 'create_po_from_mrp',
            is_error_msg   => 'MRP 转采购完成 run=' || ii_run_id || ' po_count=' || oi_po_count
                          || ' line_count=' || v_plans.COUNT,
            is_biz_key     => TO_CHAR(ii_run_id),
            is_error_level => 'INFO');
    END create_po_from_mrp;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：reorder_scan
    *****************************************************************/
    PROCEDURE reorder_scan(
        ii_warehouse_id  IN  NUMBER,
        oi_suggest_count OUT NUMBER
    ) IS
        v_suggest_qty NUMBER;

        -- 显式游标遍历低于再订货点的物料，for update 锁余额行
        -- 可用量 = qty_on_hand - qty_allocated 跌破 reorder_point 即提补货建议
        CURSOR c_low IS
            SELECT b.item_id,
                   b.warehouse_id,
                   b.qty_on_hand,
                   b.qty_allocated,
                   i.reorder_point,
                   i.reorder_qty,
                   i.safety_stock,
                   i.item_code
              FROM t_inventory_balance b
              JOIN t_item i ON i.item_id = b.item_id
             WHERE b.warehouse_id = ii_warehouse_id
               AND i.status = 'ACTIVE'
               AND i.reorder_point > 0
               AND (b.qty_on_hand - b.qty_allocated) < i.reorder_point
               FOR UPDATE OF b.qty_on_hand;
    BEGIN
        oi_suggest_count := 0;

        FOR r IN c_low LOOP
            -- 补到 再订货点 + 安全库存，至少一个再订货批量
            v_suggest_qty := GREATEST(
                r.reorder_qty,
                (r.reorder_point + r.safety_stock) - (r.qty_on_hand - r.qty_allocated));

            -- where current of 落最后扫描时间(借 last_txn_date 标记本次已看过)
            UPDATE t_inventory_balance
               SET last_txn_date = MFG_ERP.F_UTIL.curr_biz_date(),
                   updated_at    = CURRENT_TIMESTAMP
             WHERE CURRENT OF c_low;

            oi_suggest_count := oi_suggest_count + 1;

            -- 建议落信息日志，供采购员或 create_po_from_mrp 之外的人工补单参考
            MFG_ERP.F_EXC.log_error(
                is_error_code  => 'I6020',
                is_module      => MFG_ERP.F_CONST.c_mod_procure,
                is_procedure   => 'reorder_scan',
                is_error_msg   => '补货建议 item=' || r.item_code
                              || ' avail=' || (r.qty_on_hand - r.qty_allocated)
                              || ' reorder_point=' || r.reorder_point
                              || ' suggest_qty=' || v_suggest_qty,
                is_biz_key     => TO_CHAR(r.item_id),
                is_error_level => 'INFO');
        END LOOP;
    END reorder_scan;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：supplier_ranking
    *****************************************************************/
    PROCEDURE supplier_ranking(
        id_from_date IN  DATE,
        id_to_date   IN  DATE,
        or_cur       OUT SYS_REFCURSOR
    ) IS
    BEGIN
        -- 排名口径: 期间收货金额(收货量*采购单价)做主排名，到货及时率做次排名
        -- 及时率 = 行 need_date >= 实际收满日 的比例(此处用 PO 头粒度近似: 收满且不晚于 expected_date)
        -- rank() 金额降序留并列名次，dense_rank() 及时率降序连续名次，演示两种分析函数差异
        OPEN or_cur FOR
            WITH po_recv AS (
                SELECT po.supplier_id,
                       po.po_id,
                       po.expected_date,
                       SUM(pl.qty_received * pl.unit_price) AS recv_amount,
                       CASE WHEN po.status IN (MFG_ERP.F_CONST.c_po_received, MFG_ERP.F_CONST.c_po_closed)
                             AND (po.expected_date IS NULL
                                  OR po.expected_date >= po.order_date)
                            THEN 1 ELSE 0 END AS on_time_flag
                  FROM t_purchase_order po
                  JOIN t_po_line pl ON pl.po_id = po.po_id
                 WHERE po.order_date BETWEEN id_from_date AND id_to_date
                   AND po.status <> MFG_ERP.F_CONST.c_po_cancelled
                 GROUP BY po.supplier_id, po.po_id, po.expected_date, po.status, po.order_date
            ),
            agg AS (
                SELECT s.supplier_id,
                       s.supplier_code,
                       s.supplier_name,
                       s.rating,
                       NVL(SUM(pr.recv_amount), 0)              AS total_amount,
                       COUNT(pr.po_id)                          AS po_count,
                       NVL(SUM(pr.on_time_flag), 0)             AS on_time_count,
                       CASE WHEN COUNT(pr.po_id) > 0
                            THEN ROUND(NVL(SUM(pr.on_time_flag), 0) / COUNT(pr.po_id), 4)
                            ELSE 0 END                          AS on_time_rate
                  FROM t_supplier s
                  LEFT JOIN po_recv pr ON pr.supplier_id = s.supplier_id
                 GROUP BY s.supplier_id, s.supplier_code, s.supplier_name, s.rating
            )
            SELECT supplier_id,
                   supplier_code,
                   supplier_name,
                   rating,
                   total_amount,
                   po_count,
                   on_time_count,
                   on_time_rate,
                   RANK()       OVER (ORDER BY total_amount DESC) AS amount_rank,
                   DENSE_RANK() OVER (ORDER BY on_time_rate DESC) AS on_time_rank,
                   ROUND(RATIO_TO_REPORT(total_amount) OVER () * 100, 2) AS amount_share_pct
              FROM agg
             ORDER BY amount_rank, on_time_rank;
    END supplier_ranking;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：cancel_po
    *****************************************************************/
    PROCEDURE cancel_po(ii_po_id IN NUMBER, is_reason IN VARCHAR2) IS
        v_po          t_purchase_order%ROWTYPE;
        v_recv_lines  NUMBER;
    BEGIN
        v_po := lock_po(ii_po_id, 'cancel_po');

        IF v_po.status = MFG_ERP.F_CONST.c_po_cancelled THEN
            RETURN;  -- 已取消，幂等
        END IF;

        -- 已收过货的单不允许直接取消，得先做退货冲销
        IF v_po.status IN (MFG_ERP.F_CONST.c_po_received, MFG_ERP.F_CONST.c_po_closed) THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_po_status_invalid, MFG_ERP.F_CONST.c_mod_procure, 'cancel_po',
                '已收货单不可取消 status=' || v_po.status, TO_CHAR(ii_po_id));
        END IF;
        SELECT COUNT(*) INTO v_recv_lines FROM t_po_line
         WHERE po_id = ii_po_id AND qty_received > 0;
        IF v_recv_lines > 0 THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_po_status_invalid, MFG_ERP.F_CONST.c_mod_procure, 'cancel_po',
                '存在已收货行不可取消 recv_lines=' || v_recv_lines, TO_CHAR(ii_po_id));
        END IF;

        UPDATE t_po_line
           SET line_status = MFG_ERP.F_CONST.c_line_cancel
         WHERE po_id = ii_po_id
           AND line_status <> MFG_ERP.F_CONST.c_line_cancel;

        UPDATE t_purchase_order
           SET status = MFG_ERP.F_CONST.c_po_cancelled
         WHERE po_id = ii_po_id;

        MFG_ERP.F_EXC.log_error(
            is_error_code  => 'I6030',
            is_module      => MFG_ERP.F_CONST.c_mod_procure,
            is_procedure   => 'cancel_po',
            is_error_msg   => 'PO 取消 po_no=' || v_po.po_no || ' reason=' || is_reason,
            is_biz_key     => TO_CHAR(ii_po_id),
            is_error_level => 'INFO');
    END cancel_po;

END f_procurement;
