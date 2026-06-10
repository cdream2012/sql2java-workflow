package com.example.mfgerp.infrastructure.exception;

import com.example.mfgerp.constant.AppConstants;
import lombok.Getter;

/**
 * Structured error codes translated from CONST_PKG error constants.
 * Each code maps to an Oracle error constant (e.g. M1001 = C_ERR_ITEM_NOT_FOUND).
 */
@Getter
public enum ErrorCode {

    // Item errors
    ITEM_NOT_FOUND(AppConstants.C_ERR_ITEM_NOT_FOUND, "Item not found"),
    ITEM_OBSOLETE(AppConstants.C_ERR_ITEM_OBSOLETE, "Item is obsolete"),
    CATEGORY_NOT_FOUND(AppConstants.C_ERR_CATEGORY_NOT_FOUND, "Category not found"),
    CATEGORY_CYCLE(AppConstants.C_ERR_CATEGORY_CYCLE, "Category tree contains cycle"),

    // UOM errors
    UOM_NOT_FOUND(AppConstants.C_ERR_UOM_NOT_FOUND, "Unit of measure not found"),
    UOM_INCOMPATIBLE(AppConstants.C_ERR_UOM_INCOMPATIBLE, "Incompatible UOM categories"),

    // BOM errors
    BOM_NOT_FOUND(AppConstants.C_ERR_BOM_NOT_FOUND, "BOM not found"),
    BOM_CYCLE(AppConstants.C_ERR_BOM_CYCLE, "BOM contains circular reference"),
    BOM_NO_ACTIVE(AppConstants.C_ERR_BOM_NO_ACTIVE, "No active BOM found for item"),
    BOM_LINE_INVALID(AppConstants.C_ERR_BOM_LINE_INVALID, "Invalid BOM line"),

    // Inventory errors
    STOCK_INSUFFICIENT(AppConstants.C_ERR_STOCK_INSUFFICIENT, "Insufficient stock"),
    LOT_NOT_FOUND(AppConstants.C_ERR_LOT_NOT_FOUND, "Lot not found"),
    LOT_EXPIRED(AppConstants.C_ERR_LOT_EXPIRED, "Lot has expired"),
    BALANCE_NOT_FOUND(AppConstants.C_ERR_BALANCE_NOT_FOUND, "Balance record not found"),
    STOCK_NEGATIVE(AppConstants.C_ERR_STOCK_NEGATIVE, "Stock would go negative"),

    // Procurement errors
    PO_NOT_FOUND(AppConstants.C_ERR_PO_NOT_FOUND, "Purchase order not found"),
    PO_STATUS_INVALID(AppConstants.C_ERR_PO_STATUS_INVALID, "Invalid PO status for this operation"),
    PO_OVER_RECEIPT(AppConstants.C_ERR_PO_OVER_RECEIPT, "Receipt exceeds ordered quantity"),
    SUPPLIER_BLOCKED(AppConstants.C_ERR_SUPPLIER_BLOCKED, "Supplier is blocked"),

    // MRP errors
    MRP_RUNNING(AppConstants.C_ERR_MRP_RUNNING, "MRP is already running"),
    MRP_RUN_NOT_FOUND(AppConstants.C_ERR_MRP_RUN_NOT_FOUND, "MRP run not found"),
    PROD_NOT_FOUND(AppConstants.C_ERR_PROD_NOT_FOUND, "Production order not found"),

    // Pricing errors
    PRICE_RULE_MISSING(AppConstants.C_ERR_PRICE_RULE_MISSING, "No price rule found"),
    PRICE_LIST_NOT_FOUND(AppConstants.C_ERR_PRICE_LIST_NOT_FOUND, "Price list not found"),

    // System error
    SYSTEM_ERROR(AppConstants.C_ERR_SYSTEM, "System error");

    private final String code;
    private final String defaultMessage;

    ErrorCode(String code, String defaultMessage) {
        this.code = code;
        this.defaultMessage = defaultMessage;
    }
}
