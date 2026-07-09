CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE BODY MFG_ERP.F_COSTING AS

    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：fifo_layers
    *****************************************************************/
    PROCEDURE fifo_layers(
        ii_item_id      IN  NUMBER,
        ii_warehouse_id IN  NUMBER,
        or_cur          OUT SYS_REFCURSOR
    ) IS
    BEGIN
        -- 按 FIFO 排队键累计可用量与累计金额,is_covering 标出"排到这批需求已被覆盖"
        -- 需求量取余额可用量做参照,layer_no 用 row_number 给批次排序号
        OPEN or_cur FOR
            SELECT lot_id,
                   lot_no,
                   receipt_date,
                   ROW_NUMBER() OVER (ORDER BY receipt_date, lot_id) AS layer_no,
                   qty_on_hand - qty_allocated AS avail_qty,
                   unit_cost,
                   ROUND((qty_on_hand - qty_allocated) * unit_cost, 4) AS layer_amount,
                   SUM(qty_on_hand - qty_allocated)
                       OVER (ORDER BY receipt_date, lot_id) AS cum_qty,
                   SUM(ROUND((qty_on_hand - qty_allocated) * unit_cost, 4))
                       OVER (ORDER BY receipt_date, lot_id) AS cum_amount,
                   CASE
                       WHEN SUM(qty_on_hand - qty_allocated)
                                OVER (ORDER BY receipt_date, lot_id)
                            >= (SELECT NVL(qty_on_hand - qty_allocated, 0)
                                  FROM t_inventory_balance
                                 WHERE item_id = ii_item_id
                                   AND warehouse_id = ii_warehouse_id)
                       THEN 'Y' ELSE 'N'
                   END AS is_covering
              FROM t_inventory_lot
             WHERE item_id = ii_item_id
               AND warehouse_id = ii_warehouse_id
               AND status = MFG_ERP.F_CONST.c_lot_available
               AND qty_on_hand - qty_allocated > 0
             ORDER BY receipt_date, lot_id;
    END fifo_layers;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：inventory_value
    *****************************************************************/
    PROCEDURE inventory_value(
        ii_warehouse_id IN  NUMBER   DEFAULT NULL,
        or_cur          OUT SYS_REFCURSOR
    ) IS
    BEGIN
        -- 货值 = qty * 估值单价。估值单价按物料估值方法取: STD 标准成本, 其余用余额均价
        -- sum() over(partition by warehouse) 给仓库小计, ratio_to_report 给物料占本仓比重
        OPEN or_cur FOR
            SELECT b.warehouse_id,
                   w.warehouse_code,
                   b.item_id,
                   it.item_code,
                   it.item_name,
                   it.valuation_method,
                   b.qty_on_hand,
                   CASE WHEN it.valuation_method = MFG_ERP.F_CONST.c_val_std
                        THEN it.std_cost ELSE b.avg_cost END AS val_unit_cost,
                   ROUND(b.qty_on_hand *
                         CASE WHEN it.valuation_method = MFG_ERP.F_CONST.c_val_std
                              THEN it.std_cost ELSE b.avg_cost END, 4) AS stock_value,
                   SUM(ROUND(b.qty_on_hand *
                         CASE WHEN it.valuation_method = MFG_ERP.F_CONST.c_val_std
                              THEN it.std_cost ELSE b.avg_cost END, 4))
                       OVER (PARTITION BY b.warehouse_id) AS wh_total_value,
                   ROUND(RATIO_TO_REPORT(
                         b.qty_on_hand *
                         CASE WHEN it.valuation_method = MFG_ERP.F_CONST.c_val_std
                              THEN it.std_cost ELSE b.avg_cost END)
                       OVER (PARTITION BY b.warehouse_id), 6) AS value_ratio
              FROM t_inventory_balance b
              JOIN t_item      it ON it.item_id      = b.item_id
              JOIN t_warehouse w  ON w.warehouse_id  = b.warehouse_id
             WHERE b.qty_on_hand > 0
               AND (ii_warehouse_id IS NULL OR b.warehouse_id = ii_warehouse_id)
             ORDER BY b.warehouse_id, stock_value DESC;
    END inventory_value;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：recompute_avg_cost
    *****************************************************************/
    PROCEDURE recompute_avg_cost(ii_item_id IN NUMBER, ii_warehouse_id IN NUMBER) IS
        v_avg NUMBER;
        v_qty NUMBER;
    BEGIN
        -- 移动加权平均: 拿当前在库批次按数量加权算单价,回写 balance.avg_cost
        -- 只算 AVAILABLE 批次,隔离/过期批不计入活动估值
        SELECT CASE WHEN NVL(SUM(qty_on_hand), 0) > 0
                    THEN ROUND(SUM(qty_on_hand * unit_cost) / SUM(qty_on_hand), 6)
                    ELSE 0 END,
               NVL(SUM(qty_on_hand), 0)
          INTO v_avg, v_qty
          FROM t_inventory_lot
         WHERE item_id = ii_item_id
           AND warehouse_id = ii_warehouse_id
           AND status = MFG_ERP.F_CONST.c_lot_available;

        UPDATE t_inventory_balance
           SET avg_cost   = v_avg,
               version    = version + 1,
               updated_at = CURRENT_TIMESTAMP
         WHERE item_id = ii_item_id
           AND warehouse_id = ii_warehouse_id;

        IF SQL%ROWCOUNT = 0 THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_balance_not_found, MFG_ERP.F_CONST.c_mod_cost, 'recompute_avg_cost',
                '余额行不存在,无法回写均价', TO_CHAR(ii_item_id) || '/' || TO_CHAR(ii_warehouse_id));
        END IF;
    END recompute_avg_cost;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：landed_cost_report
    *****************************************************************/
    PROCEDURE landed_cost_report(
        ii_po_id  IN  NUMBER,
        or_cur    OUT SYS_REFCURSOR
    ) IS
        v_freight NUMBER := MFG_ERP.F_UTIL.get_param('LANDED_FREIGHT', TO_NUMBER(0));
        v_duty    NUMBER := MFG_ERP.F_UTIL.get_param('LANDED_DUTY',    TO_NUMBER(0));
        -- 分摊基准: AMT 按金额, WGT 按重量(取物料重量*数量),默认按金额
        v_basis   VARCHAR2(8) := MFG_ERP.F_UTIL.get_param('LANDED_BASIS', 'AMT');
        v_exists  NUMBER;
    BEGIN
        SELECT COUNT(*) INTO v_exists FROM t_purchase_order WHERE po_id = ii_po_id;
        IF v_exists = 0 THEN
            MFG_ERP.F_EXC.raise_biz_error(
                MFG_ERP.F_CONST.c_err_po_not_found, MFG_ERP.F_CONST.c_mod_cost, 'landed_cost_report',
                'PO 不存在 po_id=' || ii_po_id, TO_CHAR(ii_po_id));
        END IF;

        -- with function: 在 SQL 里内联定义分摊函数,把某项费用按行占比摊到 PO 行
        -- p_total_charge 为该项费用总额, p_line_base/p_sum_base 为本行/全单的分摊基准量
        OPEN or_cur FOR
            WITH FUNCTION alloc_charge(
                     p_total_charge IN NUMBER,
                     p_line_base    IN NUMBER,
                     p_sum_base     IN NUMBER
                 ) RETURN NUMBER IS
                 BEGIN
                     IF NVL(p_sum_base, 0) = 0 THEN
                         RETURN 0;
                     END IF;
                     RETURN ROUND(p_total_charge * p_line_base / p_sum_base, 4);
                 END;
            base AS (
                SELECT pl.po_line_id,
                       pl.line_no,
                       pl.item_id,
                       it.item_code,
                       it.item_name,
                       pl.qty_ordered,
                       pl.unit_price,
                       ROUND(pl.qty_ordered * pl.unit_price, 4) AS line_amount,
                       ROUND(pl.qty_ordered * NVL(it.dim.weight_kg, 0), 4) AS line_weight,
                       CASE WHEN v_basis = 'WGT'
                            THEN ROUND(pl.qty_ordered * NVL(it.dim.weight_kg, 0), 4)
                            ELSE ROUND(pl.qty_ordered * pl.unit_price, 4)
                       END AS alloc_base
                  FROM t_po_line pl
                  JOIN t_item it ON it.item_id = pl.item_id
                 WHERE pl.po_id = ii_po_id
            )
            SELECT po_line_id,
                   line_no,
                   item_id,
                   item_code,
                   item_name,
                   qty_ordered,
                   unit_price,
                   line_amount,
                   line_weight,
                   alloc_charge(v_freight, alloc_base, SUM(alloc_base) OVER ()) AS freight_alloc,
                   alloc_charge(v_duty,    alloc_base, SUM(alloc_base) OVER ()) AS duty_alloc,
                   line_amount
                   + alloc_charge(v_freight, alloc_base, SUM(alloc_base) OVER ())
                   + alloc_charge(v_duty,    alloc_base, SUM(alloc_base) OVER ()) AS landed_total,
                   ROUND((line_amount
                          + alloc_charge(v_freight, alloc_base, SUM(alloc_base) OVER ())
                          + alloc_charge(v_duty,    alloc_base, SUM(alloc_base) OVER ()))
                         / NULLIF(qty_ordered, 0), 6) AS landed_unit_cost
              FROM base
             ORDER BY line_no;
    END landed_cost_report;


    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：roll_standard_cost
    *****************************************************************/
    PROCEDURE roll_standard_cost(id_as_of IN DATE DEFAULT NULL) IS
        v_as_of   DATE := NVL(id_as_of, MFG_ERP.F_UTIL.curr_biz_date());
        v_rolled  NUMBER;
        v_cnt     NUMBER := 0;
        v_fail    NUMBER := 0;
    BEGIN
        -- 只对成品/半成品卷算(原料/服务无 BOM,标准成本由采购或人工维护)
        -- 逐料调 MFG_ERP.F_BOM.rolled_cost 沿 BOM 自底向上累加;单料失败不阻断整批
        FOR r IN (
            SELECT item_id, item_code
              FROM t_item
             WHERE item_type IN (MFG_ERP.F_CONST.c_item_fg, MFG_ERP.F_CONST.c_item_semi)
               AND status = 'ACTIVE'
        ) LOOP
            BEGIN
                v_rolled := MFG_ERP.F_BOM.rolled_cost(r.item_id, v_as_of);

                MERGE INTO t_item t
                USING (SELECT r.item_id AS item_id FROM DUAL) s
                ON (t.item_id = s.item_id)
                WHEN MATCHED THEN
                    UPDATE SET t.std_cost   = ROUND(v_rolled, 6),
                               t.updated_by  = MFG_ERP.F_UTIL.get_operator(),
                               t.updated_at  = CURRENT_TIMESTAMP;

                v_cnt := v_cnt + 1;
            EXCEPTION
                WHEN OTHERS THEN
                    -- 缺 ACTIVE BOM、环路等单料异常记 WARN 继续,跑批不因一个料崩
                    v_fail := v_fail + 1;
                    MFG_ERP.F_EXC.log_error(
                        is_error_code  => MFG_ERP.F_CONST.c_err_bom_no_active,
                        is_module      => MFG_ERP.F_CONST.c_mod_cost,
                        is_procedure   => 'roll_standard_cost',
                        is_error_msg   => '卷算失败 item=' || r.item_code || ' err=' || SQLERRM,
                        is_biz_key     => TO_CHAR(r.item_id),
                        is_error_level => 'WARN');
            END;
        END LOOP;

        MFG_ERP.F_EXC.log_error(
            is_error_code  => 'I3010',
            is_module      => MFG_ERP.F_CONST.c_mod_cost,
            is_procedure   => 'roll_standard_cost',
            is_error_msg   => '标准成本卷算完成 as_of=' || TO_CHAR(v_as_of, 'YYYY-MM-DD')
                          || ' ok=' || v_cnt || ' fail=' || v_fail,
            is_error_level => 'INFO');
    END roll_standard_cost;

END f_costing;
