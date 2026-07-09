CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE BODY MFG_ERP.F_INVENTORY AS

    -- 私有: 写一条库存流水，txn_id/txn_no 同源派生，返回 txn_id
    -- qty_before/qty_after 取余额快照口径(物料+仓库维度)，批次粒度的明细看批次表
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：私有: 写一条库存流水，txn_id/txn_no 同源派生，返回 txn_id / qty_before/qty_after 取余额快照口径(物料+仓库维度)，批次粒度的明细看批次表
    *****************************************************************/
    FUNCTION post_txn(
        ii_item_id      IN NUMBER,
        ii_warehouse_id IN NUMBER,
        ii_lot_id       IN NUMBER,
        is_txn_type     IN VARCHAR2,
        is_direction    IN VARCHAR2,
        ii_qty          IN NUMBER,
        ii_unit_cost    IN NUMBER,
        ii_qty_before   IN NUMBER,
        ii_qty_after    IN NUMBER,
        is_ref_doc_type IN VARCHAR2,
        ii_ref_doc_id   IN NUMBER,
        is_remark       IN VARCHAR2 DEFAULT NULL
    ) RETURN NUMBER IS
        v_txn_id NUMBER;
    BEGIN
        v_txn_id := seq_inv_txn_id.NEXTVAL;

        INSERT INTO t_inventory_txn(
            txn_id, txn_no, item_id, warehouse_id, lot_id,
            txn_type, direction, quantity, unit_cost, total_cost,
            qty_before, qty_after, txn_date, txn_time,
            ref_doc_type, ref_doc_id, operator, remark
        ) VALUES (
            v_txn_id,
            MFG_ERP.F_UTIL.gen_doc_no('IT', v_txn_id, MFG_ERP.F_UTIL.curr_biz_date()),
            ii_item_id, ii_warehouse_id, ii_lot_id,
            is_txn_type, is_direction, ii_qty, ii_unit_cost,
            ROUND(ii_qty * NVL(ii_unit_cost, 0), 4),
            ii_qty_before, ii_qty_after, MFG_ERP.F_UTIL.curr_biz_date(), CURRENT_TIMESTAMP,
            is_ref_doc_type, ii_ref_doc_id, MFG_ERP.F_UTIL.get_operator(), is_remark
        );
        RETURN v_txn_id;
    END post_txn;


    -- 私有: 余额行 merge。入库带成本时按移动加权重算 avg_cost，纯出库 p_in_cost 传 null 不动均价
    -- version+1 给上层乐观锁;余额由本包独占维护,触发器不碰这张表
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：私有: 余额行 merge。入库带成本时按移动加权重算 avg_cost，纯出库 p_in_cost 传 null 不动均价 / version+1 给上层乐观锁;余额由本包独占维护,触发器不碰这张表
    *****************************************************************/
    PROCEDURE upsert_balance(
        ii_item_id      IN NUMBER,
        ii_warehouse_id IN NUMBER,
        ii_delta_qty    IN NUMBER,
        ii_in_qty       IN NUMBER DEFAULT 0,
        ii_in_cost      IN NUMBER DEFAULT NULL
    ) IS
    BEGIN
        MERGE INTO t_inventory_balance b
        USING (SELECT ii_item_id AS item_id, ii_warehouse_id AS warehouse_id FROM DUAL) s
        ON (b.item_id = s.item_id AND b.warehouse_id = s.warehouse_id)
        WHEN MATCHED THEN
            UPDATE SET
                b.avg_cost = CASE
                    WHEN ii_in_cost IS NOT NULL AND (b.qty_on_hand + ii_in_qty) > 0
                    THEN ROUND((b.qty_on_hand * b.avg_cost + ii_in_qty * ii_in_cost)
                               / (b.qty_on_hand + ii_in_qty), 6)
                    ELSE b.avg_cost
                END,
                b.qty_on_hand   = b.qty_on_hand + ii_delta_qty,
                b.last_txn_date = MFG_ERP.F_UTIL.curr_biz_date(),
                b.version       = b.version + 1,
                b.updated_at    = CURRENT_TIMESTAMP
        WHEN NOT MATCHED THEN
            INSERT (item_id, warehouse_id, qty_on_hand, qty_allocated,
                    avg_cost, last_txn_date, version, updated_at)
            VALUES (s.item_id, s.warehouse_id, ii_delta_qty, 0,
                    NVL(ii_in_cost, 0), MFG_ERP.F_UTIL.curr_biz_date(), 0, CURRENT_TIMESTAMP);
    END upsert_balance;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：receive_stock
    *****************************************************************/
    PROCEDURE receive_stock(
        ii_item_id       IN  NUMBER,
        ii_warehouse_id  IN  NUMBER,
        ii_qty           IN  NUMBER,
        ii_unit_cost     IN  NUMBER,
        is_lot_no        IN  VARCHAR2 DEFAULT NULL,
        is_ref_doc_type  IN  VARCHAR2 DEFAULT NULL,
        ii_ref_doc_id    IN  NUMBER   DEFAULT NULL,
        oi_lot_id        OUT NUMBER,
        oi_txn_id        OUT NUMBER
    ) IS
        v_qty_before NUMBER;
        v_lot_id     NUMBER := seq_lot_id.NEXTVAL;   -- 一次取号,id 与缺省 lot_no 同源,避免序列被拉两次
        v_lot_no     VARCHAR2(40);
    BEGIN
        IF ii_qty IS NULL OR ii_qty <= 0 THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_stock_negative, MFG_ERP.F_CONST.c_mod_inv, 'receive_stock',
                '收货数量必须 > 0', TO_CHAR(ii_item_id));
        END IF;

        SELECT NVL(MAX(qty_on_hand), 0) INTO v_qty_before
          FROM t_inventory_balance
         WHERE item_id = ii_item_id AND warehouse_id = ii_warehouse_id;

        -- 批次号缺省自动生成确保唯一; returning into 取回入库后的 lot_id 作为出参
        v_lot_no := NVL(is_lot_no, MFG_ERP.F_UTIL.gen_doc_no('LOT', v_lot_id, MFG_ERP.F_UTIL.curr_biz_date()));

        INSERT INTO t_inventory_lot(
            lot_id, lot_no, item_id, warehouse_id,
            qty_on_hand, qty_allocated, unit_cost, currency_code,
            receipt_date, status, source_doc_type, source_doc_id
        ) VALUES (
            v_lot_id, v_lot_no, ii_item_id, ii_warehouse_id,
            ii_qty, 0, NVL(ii_unit_cost, 0), MFG_ERP.F_CONST.c_default_currency,
            MFG_ERP.F_UTIL.curr_biz_date(), MFG_ERP.F_CONST.c_lot_available, is_ref_doc_type, ii_ref_doc_id
        )
        RETURNING lot_id INTO oi_lot_id;

        oi_txn_id := post_txn(
            p_item_id      => ii_item_id,
            p_warehouse_id => ii_warehouse_id,
            p_lot_id       => oi_lot_id,
            p_txn_type     => MFG_ERP.F_CONST.c_txn_recv,
            p_direction    => MFG_ERP.F_CONST.c_dir_in,
            p_qty          => ii_qty,
            p_unit_cost    => NVL(ii_unit_cost, 0),
            p_qty_before   => v_qty_before,
            p_qty_after    => v_qty_before + ii_qty,
            p_ref_doc_type => is_ref_doc_type,
            p_ref_doc_id   => ii_ref_doc_id,
            p_remark       => '收货 lot=' || v_lot_no);

        upsert_balance(ii_item_id, ii_warehouse_id, ii_qty, ii_qty, NVL(ii_unit_cost, 0));
    END receive_stock;


    -- 编码版: 查出 id 后委托给 id 版，缺省单位成本取物料标准成本
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：编码版: 查出 id 后委托给 id 版，缺省单位成本取物料标准成本
    *****************************************************************/
    PROCEDURE receive_stock(
        is_item_code       IN  VARCHAR2,
        is_warehouse_code  IN  VARCHAR2,
        ii_qty             IN  NUMBER,
        is_lot_no          IN  VARCHAR2 DEFAULT NULL,
        oi_lot_id          OUT NUMBER,
        oi_txn_id          OUT NUMBER
    ) IS
        v_item_id  NUMBER;
        v_wh_id    NUMBER;
        v_std_cost NUMBER;
    BEGIN
        BEGIN
            SELECT item_id, std_cost INTO v_item_id, v_std_cost
              FROM t_item WHERE item_code = is_item_code;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                MFG_ERP.F_EXC.raise_biz_error(
                    MFG_ERP.F_CONST.c_err_item_not_found, MFG_ERP.F_CONST.c_mod_inv, 'receive_stock',
                    '物料编码不存在 ' || is_item_code, is_item_code);
        END;

        BEGIN
            SELECT warehouse_id INTO v_wh_id
              FROM t_warehouse WHERE warehouse_code = is_warehouse_code;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                MFG_ERP.F_EXC.raise_biz_error(
                    MFG_ERP.F_CONST.c_err_balance_not_found, MFG_ERP.F_CONST.c_mod_inv, 'receive_stock',
                    '仓库编码不存在 ' || is_warehouse_code, is_warehouse_code);
        END;

        receive_stock(
            ii_item_id      => v_item_id,
            ii_warehouse_id => v_wh_id,
            ii_qty          => ii_qty,
            ii_unit_cost    => v_std_cost,
            is_lot_no       => is_lot_no,
            is_ref_doc_type => NULL,
            ii_ref_doc_id   => NULL,
            oi_lot_id       => oi_lot_id,
            oi_txn_id       => oi_txn_id);
    END receive_stock;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：issue_stock
    *****************************************************************/
    PROCEDURE issue_stock(
        ii_item_id       IN  NUMBER,
        ii_warehouse_id  IN  NUMBER,
        ii_qty           IN  NUMBER,
        is_ref_doc_type  IN  VARCHAR2 DEFAULT NULL,
        ii_ref_doc_id    IN  NUMBER   DEFAULT NULL,
        ot_alloc         OUT NOCOPY t_alloc_tab
    ) IS
        -- FIFO: 按 receipt_date、lot_id 升序排队;窗口函数算到本批为止的累计可用量
        -- cum_before 是"扣到本批之前已能满足的量",据此算本批要扣多少
        CURSOR cur_fifo IS
            SELECT lot_id, lot_no, unit_cost,
                   (qty_on_hand - qty_allocated) AS avail,
                   SUM(qty_on_hand - qty_allocated)
                       OVER (ORDER BY receipt_date, lot_id) AS cum_avail
              FROM t_inventory_lot
             WHERE item_id = ii_item_id
               AND warehouse_id = ii_warehouse_id
               AND status = MFG_ERP.F_CONST.c_lot_available
               AND qty_on_hand - qty_allocated > 0
             ORDER BY receipt_date, lot_id
             FOR UPDATE OF qty_on_hand;

        v_total_avail NUMBER;
        v_remaining   NUMBER;
        v_take        NUMBER;
        v_qty_before  NUMBER;
        v_qty_run     NUMBER;
        v_idx         PLS_INTEGER := 0;
    BEGIN
        IF ii_qty IS NULL OR ii_qty <= 0 THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_stock_negative, MFG_ERP.F_CONST.c_mod_inv, 'issue_stock',
                '发料数量必须 > 0', TO_CHAR(ii_item_id));
        END IF;

        -- 先用余额快照挡一道,不足直接抛,省去无谓的逐批锁
        v_total_avail := get_available(ii_item_id, ii_warehouse_id);
        IF v_total_avail < ii_qty THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_stock_insufficient, MFG_ERP.F_CONST.c_mod_inv, 'issue_stock',
                '可用量不足 avail=' || v_total_avail || ' need=' || ii_qty,
                TO_CHAR(ii_item_id) || '/' || TO_CHAR(ii_warehouse_id));
        END IF;

        ot_alloc     := t_alloc_tab();
        v_remaining := ii_qty;
        v_qty_before := v_total_avail;
        v_qty_run    := v_total_avail;

        FOR r IN cur_fifo LOOP
            EXIT WHEN v_remaining <= 0;

            -- 本批最多扣 avail,扣到需求填满为止;cum_avail 用来确认排到第几批已覆盖需求
            v_take := LEAST(r.avail, v_remaining);

            UPDATE t_inventory_lot
               SET qty_on_hand = qty_on_hand - v_take,
                   status = CASE WHEN qty_on_hand - v_take = 0
                                 THEN MFG_ERP.F_CONST.c_lot_consumed
                                 ELSE status END
             WHERE CURRENT OF cur_fifo;

            v_idx := v_idx + 1;
            ot_alloc.EXTEND;
            ot_alloc(v_idx) := t_alloc_obj(r.lot_id, r.lot_no, v_take, r.unit_cost);

            v_qty_run := v_qty_run - v_take;
            -- 每扣一批写一条 ISSUE 流水,批次成本带上供上层做成本分摊
            DECLARE
                v_dummy NUMBER;
            BEGIN
                v_dummy := post_txn(
                    p_item_id      => ii_item_id,
                    p_warehouse_id => ii_warehouse_id,
                    p_lot_id       => r.lot_id,
                    p_txn_type     => MFG_ERP.F_CONST.c_txn_issue,
                    p_direction    => MFG_ERP.F_CONST.c_dir_out,
                    p_qty          => v_take,
                    p_unit_cost    => r.unit_cost,
                    p_qty_before   => v_qty_run + v_take,
                    p_qty_after    => v_qty_run,
                    p_ref_doc_type => is_ref_doc_type,
                    p_ref_doc_id   => ii_ref_doc_id,
                    p_remark       => 'FIFO 发料 lot=' || r.lot_no);
            END;

            v_remaining := v_remaining - v_take;
        END LOOP;

        -- 出库不改均价(p_in_cost 默认 null),仅减 qty
        upsert_balance(ii_item_id, ii_warehouse_id, -ii_qty);
    END issue_stock;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：bulk_receive
    *****************************************************************/
    PROCEDURE bulk_receive(
        it_lines      IN  t_recv_tab,
        oi_ok_count   OUT NUMBER,
        oi_fail_count OUT NUMBER
    ) IS
        -- forall save exceptions: 批量插批次,单行违约(如负数/外键)不阻断整批
        -- 失败后遍历 sql%bulk_exceptions 统计失败行数并落日志
        TYPE t_lot_id_tab IS TABLE OF NUMBER  INDEX BY PLS_INTEGER;
        TYPE t_flag_tab   IS TABLE OF BOOLEAN INDEX BY PLS_INTEGER;
        v_lot_ids t_lot_id_tab;
        v_failed  t_flag_tab;        -- 标记哪几行插批次失败,后续流水/余额跳过它们
        v_dml_err NUMBER;
        v_dummy   NUMBER;
    BEGIN
        oi_ok_count   := 0;
        oi_fail_count := 0;

        IF it_lines.COUNT = 0 THEN
            RETURN;
        END IF;

        -- 先给每行预分配 lot_id,后面流水/余额沿用同一组 id
        FOR i IN it_lines.FIRST .. it_lines.LAST LOOP
            v_lot_ids(i) := seq_lot_id.NEXTVAL;
        END LOOP;

        BEGIN
            FORALL i IN it_lines.FIRST .. it_lines.LAST SAVE EXCEPTIONS
                INSERT INTO t_inventory_lot(
                    lot_id, lot_no, item_id, warehouse_id,
                    qty_on_hand, qty_allocated, unit_cost, currency_code,
                    receipt_date, status, source_doc_type, source_doc_id
                ) VALUES (
                    v_lot_ids(i),
                    NVL(it_lines(i).lot_no,
                        MFG_ERP.F_UTIL.gen_doc_no('LOT', v_lot_ids(i), MFG_ERP.F_UTIL.curr_biz_date())),
                    it_lines(i).item_id, it_lines(i).warehouse_id,
                    it_lines(i).qty, 0, NVL(it_lines(i).unit_cost, 0), MFG_ERP.F_CONST.c_default_currency,
                    MFG_ERP.F_UTIL.curr_biz_date(), MFG_ERP.F_CONST.c_lot_available,
                    it_lines(i).ref_doc_type, it_lines(i).ref_doc_id
                );
            oi_ok_count := it_lines.COUNT;
        EXCEPTION
            WHEN OTHERS THEN
                -- -24381: forall 累积了至少一行错误,逐条取 bulk_exceptions 标失败行
                IF SQLCODE = -24381 THEN
                    v_dml_err    := SQL%BULK_EXCEPTIONS.COUNT;
                    oi_fail_count := v_dml_err;
                    oi_ok_count   := it_lines.COUNT - v_dml_err;
                    FOR j IN 1 .. v_dml_err LOOP
                        -- error_index 是 forall 迭代序号,需折算回 p_lines 的实际下标
                        v_failed(it_lines.FIRST + SQL%BULK_EXCEPTIONS(j).error_index - 1) := TRUE;
                        MFG_ERP.F_EXC.log_error(
                            is_error_code  => MFG_ERP.F_CONST.c_err_stock_negative,
                            is_module      => MFG_ERP.F_CONST.c_mod_inv,
                            is_procedure   => 'bulk_receive',
                            is_error_msg   => '批量收货行失败 idx='
                                          || SQL%BULK_EXCEPTIONS(j).error_index
                                          || ' err=' || SQLERRM(-SQL%BULK_EXCEPTIONS(j).error_code),
                            is_error_level => 'WARN');
                    END LOOP;
                ELSE
                    RAISE;
                END IF;
        END;

        -- 成功落库的行补流水与余额,失败行(v_failed 标记)跳过
        FOR i IN it_lines.FIRST .. it_lines.LAST LOOP
            IF v_failed.EXISTS(i) THEN
                CONTINUE;
            END IF;
            v_dummy := post_txn(
                p_item_id      => it_lines(i).item_id,
                p_warehouse_id => it_lines(i).warehouse_id,
                p_lot_id       => v_lot_ids(i),
                p_txn_type     => MFG_ERP.F_CONST.c_txn_recv,
                p_direction    => MFG_ERP.F_CONST.c_dir_in,
                p_qty          => it_lines(i).qty,
                p_unit_cost    => NVL(it_lines(i).unit_cost, 0),
                p_qty_before   => NULL,
                p_qty_after    => NULL,
                p_ref_doc_type => it_lines(i).ref_doc_type,
                p_ref_doc_id   => it_lines(i).ref_doc_id,
                p_remark       => '批量收货 lot=' || v_lot_ids(i));
            upsert_balance(it_lines(i).item_id, it_lines(i).warehouse_id,
                           it_lines(i).qty, it_lines(i).qty, NVL(it_lines(i).unit_cost, 0));
        END LOOP;

        MFG_ERP.F_EXC.log_error(
            is_error_code  => 'I3001',
            is_module      => MFG_ERP.F_CONST.c_mod_inv,
            is_procedure   => 'bulk_receive',
            is_error_msg   => '批量收货 total=' || it_lines.COUNT
                          || ' ok=' || oi_ok_count || ' fail=' || oi_fail_count,
            is_error_level => 'INFO');
    END bulk_receive;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：adjust_stock
    *****************************************************************/
    PROCEDURE adjust_stock(
        ii_item_id      IN NUMBER,
        ii_warehouse_id IN NUMBER,
        ii_new_qty      IN NUMBER,
        is_reason       IN VARCHAR2
    ) IS
        v_cur_qty  NUMBER;
        v_diff     NUMBER;
        v_avg_cost NUMBER;
        v_dummy    NUMBER;
        v_lot_id   NUMBER;
    BEGIN
        IF ii_new_qty IS NULL OR ii_new_qty < 0 THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_stock_negative, MFG_ERP.F_CONST.c_mod_inv, 'adjust_stock',
                '盘点数量不能为负', TO_CHAR(ii_item_id));
        END IF;

        v_cur_qty := get_available(ii_item_id, ii_warehouse_id);
        v_diff    := ii_new_qty - v_cur_qty;

        IF v_diff = 0 THEN
            RETURN;
        END IF;

        IF v_diff > 0 THEN
            -- 盘盈: 新建盈余批次承接,成本沿用当前均价(余额行没有则按 0)
            BEGIN
                SELECT avg_cost INTO v_avg_cost
                  FROM t_inventory_balance
                 WHERE item_id = ii_item_id AND warehouse_id = ii_warehouse_id;
            EXCEPTION
                WHEN NO_DATA_FOUND THEN
                    v_avg_cost := 0;
            END;

            receive_stock(
                ii_item_id      => ii_item_id,
                ii_warehouse_id => ii_warehouse_id,
                ii_qty          => v_diff,
                ii_unit_cost    => v_avg_cost,
                is_lot_no       => NULL,
                is_ref_doc_type => MFG_ERP.F_CONST.c_txn_adj,
                ii_ref_doc_id   => NULL,
                oi_lot_id       => v_lot_id,
                oi_txn_id       => v_dummy);

            -- 把 RECV 流水改记成 ADJ 口径(同事务,语义更准)
            UPDATE t_inventory_txn
               SET txn_type = MFG_ERP.F_CONST.c_txn_adj,
                   remark   = '盘盈 ' || is_reason
             WHERE txn_id = v_dummy;
        ELSE
            -- 盘亏: 走 FIFO 扣减,但流水类型记 ADJ
            DECLARE
                v_alloc t_alloc_tab;
            BEGIN
                issue_stock(
                    ii_item_id      => ii_item_id,
                    ii_warehouse_id => ii_warehouse_id,
                    ii_qty          => -v_diff,
                    is_ref_doc_type => MFG_ERP.F_CONST.c_txn_adj,
                    ii_ref_doc_id   => NULL,
                    ot_alloc        => v_alloc);
            END;

            UPDATE t_inventory_txn
               SET txn_type = MFG_ERP.F_CONST.c_txn_adj,
                   remark   = '盘亏 ' || is_reason
             WHERE item_id = ii_item_id
               AND warehouse_id = ii_warehouse_id
               AND txn_type = MFG_ERP.F_CONST.c_txn_issue
               AND txn_date = MFG_ERP.F_UTIL.curr_biz_date()
               AND ref_doc_type = MFG_ERP.F_CONST.c_txn_adj;
        END IF;

        sync_balance(ii_item_id, ii_warehouse_id);
    END adjust_stock;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：transfer_stock
    *****************************************************************/
    PROCEDURE transfer_stock(
        ii_item_id      IN NUMBER,
        ii_from_wh      IN NUMBER,
        ii_to_wh        IN NUMBER,
        ii_qty          IN NUMBER
    ) IS
        v_alloc      t_alloc_tab;
        v_total_cost NUMBER := 0;
        v_xfer_cost  NUMBER;
        v_lot_id     NUMBER;
        v_dummy      NUMBER;
    BEGIN
        IF ii_from_wh = ii_to_wh THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_balance_not_found, MFG_ERP.F_CONST.c_mod_inv, 'transfer_stock',
                '调出调入仓库不能相同', TO_CHAR(ii_from_wh));
        END IF;
        IF ii_qty IS NULL OR ii_qty <= 0 THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_stock_negative, MFG_ERP.F_CONST.c_mod_inv, 'transfer_stock',
                '调拨数量必须 > 0', TO_CHAR(ii_item_id));
        END IF;

        -- 出库走 FIFO,拿到每批成本;调入按出库的加权成本入,保证成本随货走
        issue_stock(
            ii_item_id      => ii_item_id,
            ii_warehouse_id => ii_from_wh,
            ii_qty          => ii_qty,
            is_ref_doc_type => MFG_ERP.F_CONST.c_txn_xfer_out,
            ii_ref_doc_id   => ii_to_wh,
            ot_alloc        => v_alloc);

        IF v_alloc IS NOT NULL THEN
            FOR i IN 1 .. v_alloc.COUNT LOOP
                v_total_cost := v_total_cost + v_alloc(i).alloc_cost();
            END LOOP;
        END IF;
        v_xfer_cost := ROUND(v_total_cost / ii_qty, 6);

        -- 把出库流水类型从 ISSUE 改记 XFER_OUT(同事务)
        UPDATE t_inventory_txn
           SET txn_type = MFG_ERP.F_CONST.c_txn_xfer_out
         WHERE item_id = ii_item_id
           AND warehouse_id = ii_from_wh
           AND txn_type = MFG_ERP.F_CONST.c_txn_issue
           AND txn_date = MFG_ERP.F_UTIL.curr_biz_date()
           AND ref_doc_type = MFG_ERP.F_CONST.c_txn_xfer_out
           AND ref_doc_id = ii_to_wh;

        -- 调入新建批次(入库 XFER_IN),与出库同一事务
        receive_stock(
            ii_item_id      => ii_item_id,
            ii_warehouse_id => ii_to_wh,
            ii_qty          => ii_qty,
            ii_unit_cost    => v_xfer_cost,
            is_lot_no       => NULL,
            is_ref_doc_type => MFG_ERP.F_CONST.c_txn_xfer_in,
            ii_ref_doc_id   => ii_from_wh,
            oi_lot_id       => v_lot_id,
            oi_txn_id       => v_dummy);

        UPDATE t_inventory_txn
           SET txn_type = MFG_ERP.F_CONST.c_txn_xfer_in
         WHERE txn_id = v_dummy;
    END transfer_stock;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：sync_balance
    *****************************************************************/
    PROCEDURE sync_balance(ii_item_id IN NUMBER, ii_warehouse_id IN NUMBER) IS
        v_qty   NUMBER;
        v_alloc NUMBER;
        v_avg   NUMBER;
    BEGIN
        -- 按批次实时重算: 可用批次的 qty/已分配/加权成本,然后 merge 覆盖余额行
        SELECT NVL(SUM(qty_on_hand), 0),
               NVL(SUM(qty_allocated), 0),
               CASE WHEN NVL(SUM(qty_on_hand), 0) > 0
                    THEN ROUND(SUM(qty_on_hand * unit_cost) / SUM(qty_on_hand), 6)
                    ELSE 0 END
          INTO v_qty, v_alloc, v_avg
          FROM t_inventory_lot
         WHERE item_id = ii_item_id
           AND warehouse_id = ii_warehouse_id
           AND status IN (MFG_ERP.F_CONST.c_lot_available, MFG_ERP.F_CONST.c_lot_quarantine);

        MERGE INTO t_inventory_balance b
        USING (SELECT ii_item_id AS item_id, ii_warehouse_id AS warehouse_id FROM DUAL) s
        ON (b.item_id = s.item_id AND b.warehouse_id = s.warehouse_id)
        WHEN MATCHED THEN
            UPDATE SET
                b.qty_on_hand   = v_qty,
                b.qty_allocated = v_alloc,
                b.avg_cost      = v_avg,
                b.last_txn_date = MFG_ERP.F_UTIL.curr_biz_date(),
                b.version       = b.version + 1,
                b.updated_at    = CURRENT_TIMESTAMP
        WHEN NOT MATCHED THEN
            INSERT (item_id, warehouse_id, qty_on_hand, qty_allocated,
                    avg_cost, last_txn_date, version, updated_at)
            VALUES (s.item_id, s.warehouse_id, v_qty, v_alloc,
                    v_avg, MFG_ERP.F_UTIL.curr_biz_date(), 0, CURRENT_TIMESTAMP);
    END sync_balance;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：get_available
    *****************************************************************/
    FUNCTION get_available(ii_item_id IN NUMBER, ii_warehouse_id IN NUMBER) RETURN NUMBER IS
        v_avail NUMBER;
    BEGIN
        SELECT NVL(qty_on_hand - qty_allocated, 0)
          INTO v_avail
          FROM t_inventory_balance
         WHERE item_id = ii_item_id AND warehouse_id = ii_warehouse_id;
        RETURN v_avail;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            -- 余额行还没建(没收过货),可用量按 0,不报错
            RETURN 0;
    END get_available;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：archive_txns_before
    *****************************************************************/
    PROCEDURE archive_txns_before(
        id_before_date IN  DATE,
        oi_archived    OUT NUMBER
    ) IS
        v_tab VARCHAR2(64);
        v_cnt NUMBER;
    BEGIN
        oi_archived := 0;
        v_tab := 't_inv_txn_arch_' || TO_CHAR(id_before_date, 'YYYYMM');

        -- 归档表按月命名，不存在则照流水表结构动态建一张空表(create as select 1=0)
        SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = UPPER(v_tab);
        IF v_cnt = 0 THEN
            EXECUTE IMMEDIATE 'create table ' || v_tab
                || ' as select * from t_inventory_txn where 1 = 0';
        END IF;

        -- 搬数与清理用绑定变量传日期，避免拼日期字面量(硬解析 + 注入风险)
        EXECUTE IMMEDIATE 'insert into ' || v_tab
            || ' select * from t_inventory_txn where txn_date < :1'
            USING id_before_date;
        oi_archived := SQL%ROWCOUNT;

        EXECUTE IMMEDIATE 'delete from t_inventory_txn where txn_date < :1'
            USING id_before_date;

        MFG_ERP.F_EXC.log_error(
            is_error_code  => 'I3090',
            is_module      => MFG_ERP.F_CONST.c_mod_inv,
            is_procedure   => 'archive_txns_before',
            is_error_msg   => '流水归档 tab=' || v_tab || ' before='
                          || TO_CHAR(id_before_date, 'YYYY-MM-DD') || ' rows=' || oi_archived,
            is_biz_key     => v_tab,
            is_error_level => 'INFO');
    EXCEPTION
        WHEN OTHERS THEN
            -- 归档动了真数据，失败必须抛出去让外层回滚，不能像普通日志那样吞掉
            MFG_ERP.F_EXC.log_error(
                is_error_code => MFG_ERP.F_CONST.c_err_system,
                is_module     => MFG_ERP.F_CONST.c_mod_inv,
                is_procedure  => 'archive_txns_before',
                is_error_msg  => '归档失败 tab=' || v_tab || ': ' || SQLERRM,
                is_biz_key    => v_tab);
            RAISE;
    END archive_txns_before;

END f_inventory;
