-- 库存收发: 收货 / 发料(FIFO) / 调整 / 调拨 / 余额同步 / 批量收货
-- receive_stock 重载: 既可传 id 也可传编码(overload by 参数类型)
-- issue_stock 走 FIFO: 窗口函数算批次累计可用量定位扣减批次，游标 where current of 逐批扣
-- bulk_receive 用 forall save exceptions + sql%bulk_exceptions 收集单行失败不阻断整批
-- 余额同步用 merge(有则更新无则插)，新批次插入用 returning into 取回 lot_id

CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE MFG_ERP.F_INVENTORY IS
    -- Author : sql2java-workflow
    -- Created : 2026-07-03
    -- Purpose : 库存收发: 收货 / 发料(FIFO) / 调整 / 调拨 / 余额同步 / 批量收货 / receive_stock 重载: 既可传 id 也可传编码(overload by 参数类型) / issue_stock 走 FIFO: 窗口函数算批次累计可用量定位扣减批次，游标 where current of 逐批扣 / bulk_receive 用 forall save exceptions + sql%bulk_exceptions 收集单行失败不阻断整批 / 余额同步用 merge(有则更新无则插)，新批次插入用 returning into 取回 lot_id

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
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：收货(按 id)，新建批次 + 写流水 + merge 余额；returning into 取新批次 id
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
    );

    -- 收货(按编码)，重载版: 编码转 id 后委托上面
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：收货(按编码)，重载版: 编码转 id 后委托上面
    *****************************************************************/
    PROCEDURE receive_stock(
        is_item_code       IN  VARCHAR2,
        is_warehouse_code  IN  VARCHAR2,
        ii_qty             IN  NUMBER,
        ii_unit_cost       IN  NUMBER,
        is_lot_no          IN  VARCHAR2 DEFAULT NULL,
        oi_lot_id          OUT NUMBER,
        oi_txn_id          OUT NUMBER
    );

    -- 发料(FIFO)，跨批次分配，返回每批扣减明细(对象嵌套表)
    -- 可用量不足抛 e_stock_insufficient；nocopy 减少大集合出参拷贝
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：发料(FIFO)，跨批次分配，返回每批扣减明细(对象嵌套表) / 可用量不足抛 e_stock_insufficient；nocopy 减少大集合出参拷贝
    *****************************************************************/
    PROCEDURE issue_stock(
        ii_item_id       IN  NUMBER,
        ii_warehouse_id  IN  NUMBER,
        ii_qty           IN  NUMBER,
        is_ref_doc_type  IN  VARCHAR2 DEFAULT NULL,
        ii_ref_doc_id    IN  NUMBER   DEFAULT NULL,
        ot_alloc         OUT NOCOPY t_alloc_tab
    );

    -- 批量收货: forall save exceptions 收集失败行
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：批量收货: forall save exceptions 收集失败行
    *****************************************************************/
    PROCEDURE bulk_receive(
        it_lines      IN  t_recv_tab,
        oi_ok_count   OUT NUMBER,
        oi_fail_count OUT NUMBER
    );

    -- 库存调整(盘盈盘亏)，差异写 ADJ 流水
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：库存调整(盘盈盘亏)，差异写 ADJ 流水
    *****************************************************************/
    PROCEDURE adjust_stock(
        ii_item_id      IN NUMBER,
        ii_warehouse_id IN NUMBER,
        ii_new_qty      IN NUMBER,
        is_reason       IN VARCHAR2
    );

    -- 仓间调拨: 出库 + 入库两条流水同一事务
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：仓间调拨: 出库 + 入库两条流水同一事务
    *****************************************************************/
    PROCEDURE transfer_stock(
        ii_item_id      IN NUMBER,
        ii_from_wh      IN NUMBER,
        ii_to_wh        IN NUMBER,
        ii_qty          IN NUMBER
    );

    -- 按批次实时重算并 merge 余额行
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：按批次实时重算并 merge 余额行
    *****************************************************************/
    PROCEDURE sync_balance(ii_item_id IN NUMBER, ii_warehouse_id IN NUMBER);

    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：get_available
    *****************************************************************/
    FUNCTION get_available(ii_item_id IN NUMBER, ii_warehouse_id IN NUMBER) RETURN NUMBER;

    -- 归档某日期前的库存流水到按月归档表
    -- 归档表名 t_inv_txn_arch_YYYYMM 运行期才定，建表/搬数/清理全走 execute immediate 动态 SQL
    -- 真实生产由 ops 跑批触发，这里给一个库内自助归档入口
    /*****************************************************************
    创建作者：sql2java-workflow
    创建日期：2026-07-03
    功能描述：归档某日期前的库存流水到按月归档表 / 归档表名 t_inv_txn_arch_YYYYMM 运行期才定，建表/搬数/清理全走 execute immediate 动态 SQL / 真实生产由 ops 跑批触发，这里给一个库内自助归档入口
    *****************************************************************/
    PROCEDURE archive_txns_before(
        id_before_date IN  DATE,
        oi_archived    OUT NUMBER
    );

END f_inventory;

-- 库存收发实现
-- 三层落地原则: 流水是事实(append-only)，批次是 FIFO 排队的明细，余额是物料+仓库的快照
-- 每个动作都按 流水 -> 批次 -> 余额 的顺序写，余额走 merge 自愈，避免余额行缺失时整笔失败
-- 发料的 FIFO 定位用窗口函数算累计可用量,再用 for update 游标逐批扣,锁粒度落到批次行
