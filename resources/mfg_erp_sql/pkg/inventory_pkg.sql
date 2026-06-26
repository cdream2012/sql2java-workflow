-- 库存收发: 收货 / 发料(FIFO) / 调整 / 调拨 / 余额同步 / 批量收货
-- receive_stock 重载: 既可传 id 也可传编码(overload by 参数类型)
-- issue_stock 走 FIFO: 窗口函数算批次累计可用量定位扣减批次，游标 where current of 逐批扣
-- bulk_receive 用 forall save exceptions + sql%bulk_exceptions 收集单行失败不阻断整批
-- 余额同步用 merge(有则更新无则插)，新批次插入用 returning into 取回 lot_id

CREATE OR REPLACE PACKAGE inventory_pkg AS

    -- 批量收货输入: record + 关联数组(集合做入参)
    TYPE t_recv_line IS RECORD (
        item_id       NUMBER(18),
        warehouse_id  NUMBER(18),
        qty           NUMBER(18,4),
        unit_cost     NUMBER(20,6),
        lot_no        VARCHAR2(40),
        ref_doc_type  VARCHAR2(16),
        ref_doc_id    NUMBER(18)
    );
    TYPE t_recv_tab IS TABLE OF t_recv_line INDEX BY PLS_INTEGER;

    -- 收货(按 id)，新建批次 + 写流水 + merge 余额；returning into 取新批次 id
    PROCEDURE receive_stock(
        p_item_id       IN  NUMBER,
        p_warehouse_id  IN  NUMBER,
        p_qty           IN  NUMBER,
        p_unit_cost     IN  NUMBER,
        p_lot_no        IN  VARCHAR2 DEFAULT NULL,
        p_ref_doc_type  IN  VARCHAR2 DEFAULT NULL,
        p_ref_doc_id    IN  NUMBER   DEFAULT NULL,
        p_lot_id        OUT NUMBER,
        p_txn_id        OUT NUMBER
    );

    -- 收货(按编码)，重载版: 编码转 id 后委托上面
    PROCEDURE receive_stock(
        p_item_code       IN  VARCHAR2,
        p_warehouse_code  IN  VARCHAR2,
        p_qty             IN  NUMBER,
        p_unit_cost       IN  NUMBER,
        p_lot_no          IN  VARCHAR2 DEFAULT NULL,
        p_lot_id          OUT NUMBER,
        p_txn_id          OUT NUMBER
    );

    -- 发料(FIFO)，跨批次分配，返回每批扣减明细(对象嵌套表)
    -- 可用量不足抛 e_stock_insufficient；nocopy 减少大集合出参拷贝
    PROCEDURE issue_stock(
        p_item_id       IN  NUMBER,
        p_warehouse_id  IN  NUMBER,
        p_qty           IN  NUMBER,
        p_ref_doc_type  IN  VARCHAR2 DEFAULT NULL,
        p_ref_doc_id    IN  NUMBER   DEFAULT NULL,
        p_alloc         OUT NOCOPY t_alloc_tab
    );

    -- 批量收货: forall save exceptions 收集失败行
    PROCEDURE bulk_receive(
        p_lines      IN  t_recv_tab,
        p_ok_count   OUT NUMBER,
        p_fail_count OUT NUMBER
    );

    -- 库存调整(盘盈盘亏)，差异写 ADJ 流水
    PROCEDURE adjust_stock(
        p_item_id      IN NUMBER,
        p_warehouse_id IN NUMBER,
        p_new_qty      IN NUMBER,
        p_reason       IN VARCHAR2
    );

    -- 仓间调拨: 出库 + 入库两条流水同一事务
    PROCEDURE transfer_stock(
        p_item_id      IN NUMBER,
        p_from_wh      IN NUMBER,
        p_to_wh        IN NUMBER,
        p_qty          IN NUMBER
    );

    -- 按批次实时重算并 merge 余额行
    PROCEDURE sync_balance(p_item_id IN NUMBER, p_warehouse_id IN NUMBER);

    FUNCTION get_available(p_item_id IN NUMBER, p_warehouse_id IN NUMBER) RETURN NUMBER;

    -- 归档某日期前的库存流水到按月归档表
    -- 归档表名 t_inv_txn_arch_YYYYMM 运行期才定，建表/搬数/清理全走 execute immediate 动态 SQL
    -- 真实生产由 ops 跑批触发，这里给一个库内自助归档入口
    PROCEDURE archive_txns_before(
        p_before_date IN  DATE,
        p_archived    OUT NUMBER
    );

END inventory_pkg;
/

-- 库存收发实现
-- 三层落地原则: 流水是事实(append-only)，批次是 FIFO 排队的明细，余额是物料+仓库的快照
-- 每个动作都按 流水 -> 批次 -> 余额 的顺序写，余额走 merge 自愈，避免余额行缺失时整笔失败
-- 发料的 FIFO 定位用窗口函数算累计可用量,再用 for update 游标逐批扣,锁粒度落到批次行

CREATE OR REPLACE PACKAGE BODY inventory_pkg AS

    -- 私有: 写一条库存流水，txn_id/txn_no 同源派生，返回 txn_id
    -- qty_before/qty_after 取余额快照口径(物料+仓库维度)，批次粒度的明细看批次表
    FUNCTION post_txn(
        p_item_id      IN NUMBER,
        p_warehouse_id IN NUMBER,
        p_lot_id       IN NUMBER,
        p_txn_type     IN VARCHAR2,
        p_direction    IN VARCHAR2,
        p_qty          IN NUMBER,
        p_unit_cost    IN NUMBER,
        p_qty_before   IN NUMBER,
        p_qty_after    IN NUMBER,
        p_ref_doc_type IN VARCHAR2,
        p_ref_doc_id   IN NUMBER,
        p_remark       IN VARCHAR2 DEFAULT NULL
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
            util_pkg.gen_doc_no('IT', v_txn_id, util_pkg.curr_biz_date()),
            p_item_id, p_warehouse_id, p_lot_id,
            p_txn_type, p_direction, p_qty, p_unit_cost,
            ROUND(p_qty * NVL(p_unit_cost, 0), 4),
            p_qty_before, p_qty_after, util_pkg.curr_biz_date(), CURRENT_TIMESTAMP,
            p_ref_doc_type, p_ref_doc_id, util_pkg.get_operator(), p_remark
        );
        RETURN v_txn_id;
    END post_txn;


    -- 私有: 余额行 merge。入库带成本时按移动加权重算 avg_cost，纯出库 p_in_cost 传 null 不动均价
    -- version+1 给上层乐观锁;余额由本包独占维护,触发器不碰这张表
    PROCEDURE upsert_balance(
        p_item_id      IN NUMBER,
        p_warehouse_id IN NUMBER,
        p_delta_qty    IN NUMBER,
        p_in_qty       IN NUMBER DEFAULT 0,
        p_in_cost      IN NUMBER DEFAULT NULL
    ) IS
    BEGIN
        MERGE INTO t_inventory_balance b
        USING (SELECT p_item_id AS item_id, p_warehouse_id AS warehouse_id FROM DUAL) s
        ON (b.item_id = s.item_id AND b.warehouse_id = s.warehouse_id)
        WHEN MATCHED THEN
            UPDATE SET
                b.avg_cost = CASE
                    WHEN p_in_cost IS NOT NULL AND (b.qty_on_hand + p_in_qty) > 0
                    THEN ROUND((b.qty_on_hand * b.avg_cost + p_in_qty * p_in_cost)
                               / (b.qty_on_hand + p_in_qty), 6)
                    ELSE b.avg_cost
                END,
                b.qty_on_hand   = b.qty_on_hand + p_delta_qty,
                b.last_txn_date = util_pkg.curr_biz_date(),
                b.version       = b.version + 1,
                b.updated_at    = CURRENT_TIMESTAMP
        WHEN NOT MATCHED THEN
            INSERT (item_id, warehouse_id, qty_on_hand, qty_allocated,
                    avg_cost, last_txn_date, version, updated_at)
            VALUES (s.item_id, s.warehouse_id, p_delta_qty, 0,
                    NVL(p_in_cost, 0), util_pkg.curr_biz_date(), 0, CURRENT_TIMESTAMP);
    END upsert_balance;


    PROCEDURE receive_stock(
        p_item_id       IN  NUMBER,
        p_warehouse_id  IN  NUMBER,
        p_qty           IN  NUMBER,
        p_unit_cost     IN  NUMBER,
        p_lot_no        IN  VARCHAR2 DEFAULT NULL,
        p_ref_doc_type  IN  VARCHAR2 DEFAULT NULL,
        p_ref_doc_id    IN  NUMBER   DEFAULT NULL,
        p_lot_id        OUT NUMBER,
        p_txn_id        OUT NUMBER
    ) IS
        v_qty_before NUMBER;
        v_lot_id     NUMBER := seq_lot_id.NEXTVAL;   -- 一次取号,id 与缺省 lot_no 同源,避免序列被拉两次
        v_lot_no     VARCHAR2(40);
    BEGIN
        IF p_qty IS NULL OR p_qty <= 0 THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_stock_negative, const_pkg.c_mod_inv, 'receive_stock',
                '收货数量必须 > 0', TO_CHAR(p_item_id));
        END IF;

        SELECT NVL(MAX(qty_on_hand), 0) INTO v_qty_before
          FROM t_inventory_balance
         WHERE item_id = p_item_id AND warehouse_id = p_warehouse_id;

        -- 批次号缺省自动生成确保唯一; returning into 取回入库后的 lot_id 作为出参
        v_lot_no := NVL(p_lot_no, util_pkg.gen_doc_no('LOT', v_lot_id, util_pkg.curr_biz_date()));

        INSERT INTO t_inventory_lot(
            lot_id, lot_no, item_id, warehouse_id,
            qty_on_hand, qty_allocated, unit_cost, currency_code,
            receipt_date, status, source_doc_type, source_doc_id
        ) VALUES (
            v_lot_id, v_lot_no, p_item_id, p_warehouse_id,
            p_qty, 0, NVL(p_unit_cost, 0), const_pkg.c_default_currency,
            util_pkg.curr_biz_date(), const_pkg.c_lot_available, p_ref_doc_type, p_ref_doc_id
        )
        RETURNING lot_id INTO p_lot_id;

        p_txn_id := post_txn(
            p_item_id      => p_item_id,
            p_warehouse_id => p_warehouse_id,
            p_lot_id       => p_lot_id,
            p_txn_type     => const_pkg.c_txn_recv,
            p_direction    => const_pkg.c_dir_in,
            p_qty          => p_qty,
            p_unit_cost    => NVL(p_unit_cost, 0),
            p_qty_before   => v_qty_before,
            p_qty_after    => v_qty_before + p_qty,
            p_ref_doc_type => p_ref_doc_type,
            p_ref_doc_id   => p_ref_doc_id,
            p_remark       => '收货 lot=' || v_lot_no);

        upsert_balance(p_item_id, p_warehouse_id, p_qty, p_qty, NVL(p_unit_cost, 0));
    END receive_stock;


    -- 编码版: 查出 id 后委托给 id 版，缺省单位成本取物料标准成本
    PROCEDURE receive_stock(
        p_item_code       IN  VARCHAR2,
        p_warehouse_code  IN  VARCHAR2,
        p_qty             IN  NUMBER,
        p_lot_no          IN  VARCHAR2 DEFAULT NULL,
        p_lot_id          OUT NUMBER,
        p_txn_id          OUT NUMBER
    ) IS
        v_item_id  NUMBER;
        v_wh_id    NUMBER;
        v_std_cost NUMBER;
    BEGIN
        BEGIN
            SELECT item_id, std_cost INTO v_item_id, v_std_cost
              FROM t_item WHERE item_code = p_item_code;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_item_not_found, const_pkg.c_mod_inv, 'receive_stock',
                    '物料编码不存在 ' || p_item_code, p_item_code);
        END;

        BEGIN
            SELECT warehouse_id INTO v_wh_id
              FROM t_warehouse WHERE warehouse_code = p_warehouse_code;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                exc_pkg.raise_biz_error(
                    const_pkg.c_err_balance_not_found, const_pkg.c_mod_inv, 'receive_stock',
                    '仓库编码不存在 ' || p_warehouse_code, p_warehouse_code);
        END;

        receive_stock(
            p_item_id      => v_item_id,
            p_warehouse_id => v_wh_id,
            p_qty          => p_qty,
            p_unit_cost    => v_std_cost,
            p_lot_no       => p_lot_no,
            p_ref_doc_type => NULL,
            p_ref_doc_id   => NULL,
            p_lot_id       => p_lot_id,
            p_txn_id       => p_txn_id);
    END receive_stock;


    PROCEDURE issue_stock(
        p_item_id       IN  NUMBER,
        p_warehouse_id  IN  NUMBER,
        p_qty           IN  NUMBER,
        p_ref_doc_type  IN  VARCHAR2 DEFAULT NULL,
        p_ref_doc_id    IN  NUMBER   DEFAULT NULL,
        p_alloc         OUT NOCOPY t_alloc_tab
    ) IS
        -- FIFO: 按 receipt_date、lot_id 升序排队;窗口函数算到本批为止的累计可用量
        -- cum_before 是"扣到本批之前已能满足的量",据此算本批要扣多少
        CURSOR cur_fifo IS
            SELECT lot_id, lot_no, unit_cost,
                   (qty_on_hand - qty_allocated) AS avail,
                   SUM(qty_on_hand - qty_allocated)
                       OVER (ORDER BY receipt_date, lot_id) AS cum_avail
              FROM t_inventory_lot
             WHERE item_id = p_item_id
               AND warehouse_id = p_warehouse_id
               AND status = const_pkg.c_lot_available
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
        IF p_qty IS NULL OR p_qty <= 0 THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_stock_negative, const_pkg.c_mod_inv, 'issue_stock',
                '发料数量必须 > 0', TO_CHAR(p_item_id));
        END IF;

        -- 先用余额快照挡一道,不足直接抛,省去无谓的逐批锁
        v_total_avail := get_available(p_item_id, p_warehouse_id);
        IF v_total_avail < p_qty THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_stock_insufficient, const_pkg.c_mod_inv, 'issue_stock',
                '可用量不足 avail=' || v_total_avail || ' need=' || p_qty,
                TO_CHAR(p_item_id) || '/' || TO_CHAR(p_warehouse_id));
        END IF;

        p_alloc     := t_alloc_tab();
        v_remaining := p_qty;
        v_qty_before := v_total_avail;
        v_qty_run    := v_total_avail;

        FOR r IN cur_fifo LOOP
            EXIT WHEN v_remaining <= 0;

            -- 本批最多扣 avail,扣到需求填满为止;cum_avail 用来确认排到第几批已覆盖需求
            v_take := LEAST(r.avail, v_remaining);

            UPDATE t_inventory_lot
               SET qty_on_hand = qty_on_hand - v_take,
                   status = CASE WHEN qty_on_hand - v_take = 0
                                 THEN const_pkg.c_lot_consumed
                                 ELSE status END
             WHERE CURRENT OF cur_fifo;

            v_idx := v_idx + 1;
            p_alloc.EXTEND;
            p_alloc(v_idx) := t_alloc_obj(r.lot_id, r.lot_no, v_take, r.unit_cost);

            v_qty_run := v_qty_run - v_take;
            -- 每扣一批写一条 ISSUE 流水,批次成本带上供上层做成本分摊
            DECLARE
                v_dummy NUMBER;
            BEGIN
                v_dummy := post_txn(
                    p_item_id      => p_item_id,
                    p_warehouse_id => p_warehouse_id,
                    p_lot_id       => r.lot_id,
                    p_txn_type     => const_pkg.c_txn_issue,
                    p_direction    => const_pkg.c_dir_out,
                    p_qty          => v_take,
                    p_unit_cost    => r.unit_cost,
                    p_qty_before   => v_qty_run + v_take,
                    p_qty_after    => v_qty_run,
                    p_ref_doc_type => p_ref_doc_type,
                    p_ref_doc_id   => p_ref_doc_id,
                    p_remark       => 'FIFO 发料 lot=' || r.lot_no);
            END;

            v_remaining := v_remaining - v_take;
        END LOOP;

        -- 出库不改均价(p_in_cost 默认 null),仅减 qty
        upsert_balance(p_item_id, p_warehouse_id, -p_qty);
    END issue_stock;


    PROCEDURE bulk_receive(
        p_lines      IN  t_recv_tab,
        p_ok_count   OUT NUMBER,
        p_fail_count OUT NUMBER
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
        p_ok_count   := 0;
        p_fail_count := 0;

        IF p_lines.COUNT = 0 THEN
            RETURN;
        END IF;

        -- 先给每行预分配 lot_id,后面流水/余额沿用同一组 id
        FOR i IN p_lines.FIRST .. p_lines.LAST LOOP
            v_lot_ids(i) := seq_lot_id.NEXTVAL;
        END LOOP;

        BEGIN
            FORALL i IN p_lines.FIRST .. p_lines.LAST SAVE EXCEPTIONS
                INSERT INTO t_inventory_lot(
                    lot_id, lot_no, item_id, warehouse_id,
                    qty_on_hand, qty_allocated, unit_cost, currency_code,
                    receipt_date, status, source_doc_type, source_doc_id
                ) VALUES (
                    v_lot_ids(i),
                    NVL(p_lines(i).lot_no,
                        util_pkg.gen_doc_no('LOT', v_lot_ids(i), util_pkg.curr_biz_date())),
                    p_lines(i).item_id, p_lines(i).warehouse_id,
                    p_lines(i).qty, 0, NVL(p_lines(i).unit_cost, 0), const_pkg.c_default_currency,
                    util_pkg.curr_biz_date(), const_pkg.c_lot_available,
                    p_lines(i).ref_doc_type, p_lines(i).ref_doc_id
                );
            p_ok_count := p_lines.COUNT;
        EXCEPTION
            WHEN OTHERS THEN
                -- -24381: forall 累积了至少一行错误,逐条取 bulk_exceptions 标失败行
                IF SQLCODE = -24381 THEN
                    v_dml_err    := SQL%BULK_EXCEPTIONS.COUNT;
                    p_fail_count := v_dml_err;
                    p_ok_count   := p_lines.COUNT - v_dml_err;
                    FOR j IN 1 .. v_dml_err LOOP
                        -- error_index 是 forall 迭代序号,需折算回 p_lines 的实际下标
                        v_failed(p_lines.FIRST + SQL%BULK_EXCEPTIONS(j).error_index - 1) := TRUE;
                        exc_pkg.log_error(
                            p_error_code  => const_pkg.c_err_stock_negative,
                            p_module      => const_pkg.c_mod_inv,
                            p_procedure   => 'bulk_receive',
                            p_error_msg   => '批量收货行失败 idx='
                                          || SQL%BULK_EXCEPTIONS(j).error_index
                                          || ' err=' || SQLERRM(-SQL%BULK_EXCEPTIONS(j).error_code),
                            p_error_level => 'WARN');
                    END LOOP;
                ELSE
                    RAISE;
                END IF;
        END;

        -- 成功落库的行补流水与余额,失败行(v_failed 标记)跳过
        FOR i IN p_lines.FIRST .. p_lines.LAST LOOP
            IF v_failed.EXISTS(i) THEN
                CONTINUE;
            END IF;
            v_dummy := post_txn(
                p_item_id      => p_lines(i).item_id,
                p_warehouse_id => p_lines(i).warehouse_id,
                p_lot_id       => v_lot_ids(i),
                p_txn_type     => const_pkg.c_txn_recv,
                p_direction    => const_pkg.c_dir_in,
                p_qty          => p_lines(i).qty,
                p_unit_cost    => NVL(p_lines(i).unit_cost, 0),
                p_qty_before   => NULL,
                p_qty_after    => NULL,
                p_ref_doc_type => p_lines(i).ref_doc_type,
                p_ref_doc_id   => p_lines(i).ref_doc_id,
                p_remark       => '批量收货 lot=' || v_lot_ids(i));
            upsert_balance(p_lines(i).item_id, p_lines(i).warehouse_id,
                           p_lines(i).qty, p_lines(i).qty, NVL(p_lines(i).unit_cost, 0));
        END LOOP;

        exc_pkg.log_error(
            p_error_code  => 'I3001',
            p_module      => const_pkg.c_mod_inv,
            p_procedure   => 'bulk_receive',
            p_error_msg   => '批量收货 total=' || p_lines.COUNT
                          || ' ok=' || p_ok_count || ' fail=' || p_fail_count,
            p_error_level => 'INFO');
    END bulk_receive;


    PROCEDURE adjust_stock(
        p_item_id      IN NUMBER,
        p_warehouse_id IN NUMBER,
        p_new_qty      IN NUMBER,
        p_reason       IN VARCHAR2
    ) IS
        v_cur_qty  NUMBER;
        v_diff     NUMBER;
        v_avg_cost NUMBER;
        v_dummy    NUMBER;
        v_lot_id   NUMBER;
    BEGIN
        IF p_new_qty IS NULL OR p_new_qty < 0 THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_stock_negative, const_pkg.c_mod_inv, 'adjust_stock',
                '盘点数量不能为负', TO_CHAR(p_item_id));
        END IF;

        v_cur_qty := get_available(p_item_id, p_warehouse_id);
        v_diff    := p_new_qty - v_cur_qty;

        IF v_diff = 0 THEN
            RETURN;
        END IF;

        IF v_diff > 0 THEN
            -- 盘盈: 新建盈余批次承接,成本沿用当前均价(余额行没有则按 0)
            BEGIN
                SELECT avg_cost INTO v_avg_cost
                  FROM t_inventory_balance
                 WHERE item_id = p_item_id AND warehouse_id = p_warehouse_id;
            EXCEPTION
                WHEN NO_DATA_FOUND THEN
                    v_avg_cost := 0;
            END;

            receive_stock(
                p_item_id      => p_item_id,
                p_warehouse_id => p_warehouse_id,
                p_qty          => v_diff,
                p_unit_cost    => v_avg_cost,
                p_lot_no       => NULL,
                p_ref_doc_type => const_pkg.c_txn_adj,
                p_ref_doc_id   => NULL,
                p_lot_id       => v_lot_id,
                p_txn_id       => v_dummy);

            -- 把 RECV 流水改记成 ADJ 口径(同事务,语义更准)
            UPDATE t_inventory_txn
               SET txn_type = const_pkg.c_txn_adj,
                   remark   = '盘盈 ' || p_reason
             WHERE txn_id = v_dummy;
        ELSE
            -- 盘亏: 走 FIFO 扣减,但流水类型记 ADJ
            DECLARE
                v_alloc t_alloc_tab;
            BEGIN
                issue_stock(
                    p_item_id      => p_item_id,
                    p_warehouse_id => p_warehouse_id,
                    p_qty          => -v_diff,
                    p_ref_doc_type => const_pkg.c_txn_adj,
                    p_ref_doc_id   => NULL,
                    p_alloc        => v_alloc);
            END;

            UPDATE t_inventory_txn
               SET txn_type = const_pkg.c_txn_adj,
                   remark   = '盘亏 ' || p_reason
             WHERE item_id = p_item_id
               AND warehouse_id = p_warehouse_id
               AND txn_type = const_pkg.c_txn_issue
               AND txn_date = util_pkg.curr_biz_date()
               AND ref_doc_type = const_pkg.c_txn_adj;
        END IF;

        sync_balance(p_item_id, p_warehouse_id);
    END adjust_stock;


    PROCEDURE transfer_stock(
        p_item_id      IN NUMBER,
        p_from_wh      IN NUMBER,
        p_to_wh        IN NUMBER,
        p_qty          IN NUMBER
    ) IS
        v_alloc      t_alloc_tab;
        v_total_cost NUMBER := 0;
        v_xfer_cost  NUMBER;
        v_lot_id     NUMBER;
        v_dummy      NUMBER;
    BEGIN
        IF p_from_wh = p_to_wh THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_balance_not_found, const_pkg.c_mod_inv, 'transfer_stock',
                '调出调入仓库不能相同', TO_CHAR(p_from_wh));
        END IF;
        IF p_qty IS NULL OR p_qty <= 0 THEN
            exc_pkg.raise_biz_error(
                const_pkg.c_err_stock_negative, const_pkg.c_mod_inv, 'transfer_stock',
                '调拨数量必须 > 0', TO_CHAR(p_item_id));
        END IF;

        -- 出库走 FIFO,拿到每批成本;调入按出库的加权成本入,保证成本随货走
        issue_stock(
            p_item_id      => p_item_id,
            p_warehouse_id => p_from_wh,
            p_qty          => p_qty,
            p_ref_doc_type => const_pkg.c_txn_xfer_out,
            p_ref_doc_id   => p_to_wh,
            p_alloc        => v_alloc);

        IF v_alloc IS NOT NULL THEN
            FOR i IN 1 .. v_alloc.COUNT LOOP
                v_total_cost := v_total_cost + v_alloc(i).alloc_cost();
            END LOOP;
        END IF;
        v_xfer_cost := ROUND(v_total_cost / p_qty, 6);

        -- 把出库流水类型从 ISSUE 改记 XFER_OUT(同事务)
        UPDATE t_inventory_txn
           SET txn_type = const_pkg.c_txn_xfer_out
         WHERE item_id = p_item_id
           AND warehouse_id = p_from_wh
           AND txn_type = const_pkg.c_txn_issue
           AND txn_date = util_pkg.curr_biz_date()
           AND ref_doc_type = const_pkg.c_txn_xfer_out
           AND ref_doc_id = p_to_wh;

        -- 调入新建批次(入库 XFER_IN),与出库同一事务
        receive_stock(
            p_item_id      => p_item_id,
            p_warehouse_id => p_to_wh,
            p_qty          => p_qty,
            p_unit_cost    => v_xfer_cost,
            p_lot_no       => NULL,
            p_ref_doc_type => const_pkg.c_txn_xfer_in,
            p_ref_doc_id   => p_from_wh,
            p_lot_id       => v_lot_id,
            p_txn_id       => v_dummy);

        UPDATE t_inventory_txn
           SET txn_type = const_pkg.c_txn_xfer_in
         WHERE txn_id = v_dummy;
    END transfer_stock;


    PROCEDURE sync_balance(p_item_id IN NUMBER, p_warehouse_id IN NUMBER) IS
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
         WHERE item_id = p_item_id
           AND warehouse_id = p_warehouse_id
           AND status IN (const_pkg.c_lot_available, const_pkg.c_lot_quarantine);

        MERGE INTO t_inventory_balance b
        USING (SELECT p_item_id AS item_id, p_warehouse_id AS warehouse_id FROM DUAL) s
        ON (b.item_id = s.item_id AND b.warehouse_id = s.warehouse_id)
        WHEN MATCHED THEN
            UPDATE SET
                b.qty_on_hand   = v_qty,
                b.qty_allocated = v_alloc,
                b.avg_cost      = v_avg,
                b.last_txn_date = util_pkg.curr_biz_date(),
                b.version       = b.version + 1,
                b.updated_at    = CURRENT_TIMESTAMP
        WHEN NOT MATCHED THEN
            INSERT (item_id, warehouse_id, qty_on_hand, qty_allocated,
                    avg_cost, last_txn_date, version, updated_at)
            VALUES (s.item_id, s.warehouse_id, v_qty, v_alloc,
                    v_avg, util_pkg.curr_biz_date(), 0, CURRENT_TIMESTAMP);
    END sync_balance;


    FUNCTION get_available(p_item_id IN NUMBER, p_warehouse_id IN NUMBER) RETURN NUMBER IS
        v_avail NUMBER;
    BEGIN
        SELECT NVL(qty_on_hand - qty_allocated, 0)
          INTO v_avail
          FROM t_inventory_balance
         WHERE item_id = p_item_id AND warehouse_id = p_warehouse_id;
        RETURN v_avail;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            -- 余额行还没建(没收过货),可用量按 0,不报错
            RETURN 0;
    END get_available;


    PROCEDURE archive_txns_before(
        p_before_date IN  DATE,
        p_archived    OUT NUMBER
    ) IS
        v_tab VARCHAR2(64);
        v_cnt NUMBER;
    BEGIN
        p_archived := 0;
        v_tab := 't_inv_txn_arch_' || TO_CHAR(p_before_date, 'YYYYMM');

        -- 归档表按月命名，不存在则照流水表结构动态建一张空表(create as select 1=0)
        SELECT COUNT(*) INTO v_cnt FROM user_tables WHERE table_name = UPPER(v_tab);
        IF v_cnt = 0 THEN
            EXECUTE IMMEDIATE 'create table ' || v_tab
                || ' as select * from t_inventory_txn where 1 = 0';
        END IF;

        -- 搬数与清理用绑定变量传日期，避免拼日期字面量(硬解析 + 注入风险)
        EXECUTE IMMEDIATE 'insert into ' || v_tab
            || ' select * from t_inventory_txn where txn_date < :1'
            USING p_before_date;
        p_archived := SQL%ROWCOUNT;

        EXECUTE IMMEDIATE 'delete from t_inventory_txn where txn_date < :1'
            USING p_before_date;

        exc_pkg.log_error(
            p_error_code  => 'I3090',
            p_module      => const_pkg.c_mod_inv,
            p_procedure   => 'archive_txns_before',
            p_error_msg   => '流水归档 tab=' || v_tab || ' before='
                          || TO_CHAR(p_before_date, 'YYYY-MM-DD') || ' rows=' || p_archived,
            p_biz_key     => v_tab,
            p_error_level => 'INFO');
    EXCEPTION
        WHEN OTHERS THEN
            -- 归档动了真数据，失败必须抛出去让外层回滚，不能像普通日志那样吞掉
            exc_pkg.log_error(
                p_error_code => const_pkg.c_err_system,
                p_module     => const_pkg.c_mod_inv,
                p_procedure  => 'archive_txns_before',
                p_error_msg  => '归档失败 tab=' || v_tab || ': ' || SQLERRM,
                p_biz_key    => v_tab);
            RAISE;
    END archive_txns_before;

END inventory_pkg;
/
