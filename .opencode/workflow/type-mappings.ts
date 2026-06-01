/**
 * Oracle → Java / JDBC 类型映射表
 */

export const ORACLE_TO_JAVA: Record<string, string> = {
  VARCHAR2: "String",
  NVARCHAR2: "String",
  CHAR: "String",
  NCHAR: "String",
  NUMBER: "BigDecimal",
  INTEGER: "Integer",
  BINARY_INTEGER: "Integer",
  PLS_INTEGER: "Integer",
  DATE: "LocalDate",
  TIMESTAMP: "LocalDateTime",
  "TIMESTAMP(6)": "LocalDateTime",
  "TIMESTAMP WITH TIME ZONE": "OffsetDateTime",
  CLOB: "String",
  BLOB: "byte[]",
  RAW: "byte[]",
  LONG: "String",
  BOOLEAN: "Boolean",
  SYS_REFCURSOR: "List<Map<String,Object>>",
}

export const ORACLE_TO_JDBC: Record<string, string> = {
  VARCHAR2: "VARCHAR",
  NVARCHAR2: "VARCHAR",
  NUMBER: "NUMERIC",
  INTEGER: "INTEGER",
  DATE: "DATE",
  TIMESTAMP: "TIMESTAMP",
  CLOB: "CLOB",
  BLOB: "BLOB",
}
