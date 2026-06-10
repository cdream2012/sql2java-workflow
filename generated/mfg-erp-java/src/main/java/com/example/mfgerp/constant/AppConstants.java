package com.example.mfgerp.constant;

/**
 * Application-level constants translated from Oracle CONST_PKG.
 * Maps all error codes, business constants from the PL/SQL package.
 */
public final class AppConstants {

    private AppConstants() {}

    // ── Module codes ──────────────────────────────────────────────
    public static final String C_MOD_ITEM     = "ITEM";
    public static final String C_MOD_BOM      = "BOM";
    public static final String C_MOD_INV      = "INV";
    public static final String C_MOD_COST     = "COST";
    public static final String C_MOD_PRICE    = "PRICE";
    public static final String C_MOD_PROCURE  = "PROCURE";
    public static final String C_MOD_MRP      = "MRP";
    public static final String C_MOD_FORECAST = "FORECAST";
    public static final String C_MOD_REPORT   = "REPORT";
    public static final String C_MOD_SCHED    = "SCHED";
    public static final String C_MOD_UTIL     = "UTIL";

    // ── Item error codes ──────────────────────────────────────────
    public static final String C_ERR_ITEM_NOT_FOUND     = "M1001";
    public static final String C_ERR_ITEM_OBSOLETE      = "M1002";
    public static final String C_ERR_CATEGORY_NOT_FOUND = "M1003";
    public static final String C_ERR_CATEGORY_CYCLE     = "M1004";

    // ── UOM error codes ───────────────────────────────────────────
    public static final String C_ERR_UOM_NOT_FOUND     = "M1101";
    public static final String C_ERR_UOM_INCOMPATIBLE  = "M1102";

    // ── BOM error codes ───────────────────────────────────────────
    public static final String C_ERR_BOM_NOT_FOUND   = "M2001";
    public static final String C_ERR_BOM_CYCLE       = "M2002";
    public static final String C_ERR_BOM_NO_ACTIVE   = "M2003";
    public static final String C_ERR_BOM_LINE_INVALID = "M2004";

    // ── Inventory error codes ─────────────────────────────────────
    public static final String C_ERR_STOCK_INSUFFICIENT = "M3001";
    public static final String C_ERR_LOT_NOT_FOUND      = "M3002";
    public static final String C_ERR_LOT_EXPIRED         = "M3003";
    public static final String C_ERR_BALANCE_NOT_FOUND   = "M3004";
    public static final String C_ERR_STOCK_NEGATIVE      = "M3005";

    // ── Procurement error codes ───────────────────────────────────
    public static final String C_ERR_PO_NOT_FOUND      = "M4001";
    public static final String C_ERR_PO_STATUS_INVALID = "M4002";
    public static final String C_ERR_PO_OVER_RECEIPT   = "M4003";
    public static final String C_ERR_SUPPLIER_BLOCKED  = "M4004";

    // ── MRP error codes ───────────────────────────────────────────
    public static final String C_ERR_MRP_RUNNING     = "M5001";
    public static final String C_ERR_MRP_RUN_NOT_FOUND = "M5002";
    public static final String C_ERR_PROD_NOT_FOUND  = "M5003";

    // ── Pricing error codes ───────────────────────────────────────
    public static final String C_ERR_PRICE_RULE_MISSING  = "M6001";
    public static final String C_ERR_PRICE_LIST_NOT_FOUND = "M6002";

    // ── System error code ─────────────────────────────────────────
    public static final String C_ERR_SYSTEM = "M9999";

    // ── Business constants ────────────────────────────────────────
    public static final int    C_MAX_BOM_LEVELS  = 20;
    public static final String C_DEFAULT_CURRENCY = "CNY";
    public static final int    C_BULK_LIMIT       = 1000;

    // ── Item types ────────────────────────────────────────────────
    public static final String C_ITEM_RAW  = "RAW";
    public static final String C_ITEM_SEMI = "SEMI";
    public static final String C_ITEM_FG   = "FG";
    public static final String C_ITEM_SVC  = "SVC";

    // ── Lot statuses ──────────────────────────────────────────────
    public static final String C_LOT_AVAILABLE  = "AVAILABLE";
    public static final String C_LOT_QUARANTINE = "QUARANTINE";
    public static final String C_LOT_EXPIRED    = "EXPIRED";
    public static final String C_LOT_CONSUMED   = "CONSUMED";

    // ── Transaction types ─────────────────────────────────────────
    public static final String C_TXN_RECV    = "RECV";
    public static final String C_TXN_ISSUE   = "ISSUE";
    public static final String C_TXN_ADJ     = "ADJ";
    public static final String C_TXN_XFER_IN = "XFER_IN";
    public static final String C_TXN_XFER_OUT = "XFER_OUT";
    public static final String C_TXN_PROD_IN = "PROD_IN";
    public static final String C_TXN_PROD_OUT = "PROD_OUT";
    public static final String C_TXN_RETURN  = "RETURN";

    // ── Directions ────────────────────────────────────────────────
    public static final String C_DIR_IN  = "I";
    public static final String C_DIR_OUT = "O";

    // ── PO statuses ───────────────────────────────────────────────
    public static final String C_PO_DRAFT     = "DRAFT";
    public static final String C_PO_APPROVED  = "APPROVED";
    public static final String C_PO_PARTIAL   = "PARTIAL";
    public static final String C_PO_RECEIVED  = "RECEIVED";
    public static final String C_PO_CLOSED    = "CLOSED";
    public static final String C_PO_CANCELLED = "CANCELLED";

    // ── PO line statuses ──────────────────────────────────────────
    public static final String C_LINE_OPEN    = "OPEN";
    public static final String C_LINE_PARTIAL = "PARTIAL";
    public static final String C_LINE_CLOSED  = "CLOSED";
    public static final String C_LINE_CANCEL  = "CANCELLED";

    // ── Valuation methods ─────────────────────────────────────────
    public static final String C_VAL_FIFO = "FIFO";
    public static final String C_VAL_STD  = "STD";
    public static final String C_VAL_AVG  = "AVG";
    public static final String C_VAL_NONE = "NONE";

    // ── Price rule types ──────────────────────────────────────────
    public static final String C_RULE_LIST         = "LIST";
    public static final String C_RULE_OVERRIDE     = "OVERRIDE";
    public static final String C_RULE_DISCOUNT_PCT = "DISCOUNT_PCT";
    public static final String C_RULE_DISCOUNT_AMT = "DISCOUNT_AMT";

    // ── MRP statuses ──────────────────────────────────────────────
    public static final String C_MRP_RUNNING = "RUNNING";
    public static final String C_MRP_SUCCESS = "SUCCESS";
    public static final String C_MRP_FAILED  = "FAILED";
    public static final String C_MRP_PARTIAL = "PARTIAL";

    // ── Production statuses ───────────────────────────────────────
    public static final String C_PROD_PLANNED    = "PLANNED";
    public static final String C_PROD_RELEASED   = "RELEASED";
    public static final String C_PROD_IN_PROGRESS = "IN_PROGRESS";
    public static final String C_PROD_COMPLETED  = "COMPLETED";
    public static final String C_PROD_CLOSED     = "CLOSED";
    public static final String C_PROD_CANCELLED  = "CANCELLED";
}
