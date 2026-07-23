/**
 * PL/SQL → Java / JDBC 类型映射表
 *
 * PLSQL_TO_JAVA: PL/SQL 类型 → Java 类型
 * PLSQL_TO_JDBC: PL/SQL 类型 → MyBatis jdbcType（用于 Mapper XML）
 */

export const PLSQL_TO_JAVA: Record<string, string> = {
  // ── 字符 ──
  VARCHAR2: "String",
  NVARCHAR2: "String",
  CHAR: "String",
  NCHAR: "String",
  CLOB: "String",
  LONG: "String",
  XMLTYPE: "String",

  // ── 数值 ──
  NUMBER: "BigDecimal",
  INTEGER: "Integer",
  BINARY_INTEGER: "Integer",
  PLS_INTEGER: "Integer",
  SIMPLE_INTEGER: "Integer",
  NATURAL: "Integer",
  POSITIVE: "Integer",
  FLOAT: "Double",
  REAL: "Float",
  SMALLINT: "Short",
  NUMERIC: "BigDecimal",
  DECIMAL: "BigDecimal",

  // ── 日期时间 ──
  DATE: "LocalDate",
  TIMESTAMP: "LocalDateTime",
  "TIMESTAMP(6)": "LocalDateTime",
  "TIMESTAMP WITH TIME ZONE": "OffsetDateTime",
  "TIMESTAMP WITH LOCAL TIME ZONE": "OffsetDateTime",

  // ── 二进制 ──
  BLOB: "byte[]",
  RAW: "byte[]",
  LONG_RAW: "byte[]",

  // ── 布尔 ──
  BOOLEAN: "Boolean",

  // ── 游标 / 复杂类型 ──
  SYS_REFCURSOR: "List<Map<String,Object>>",
  ROWID: "String",
  UROWID: "String",
}

export const PLSQL_TO_JDBC: Record<string, string> = {
  // ── 字符 ──
  VARCHAR2: "VARCHAR",
  NVARCHAR2: "NVARCHAR",
  CHAR: "CHAR",
  NCHAR: "NCHAR",
  CLOB: "CLOB",
  LONG: "LONGVARCHAR",
  XMLTYPE: "CLOB",

  // ── 数值 ──
  NUMBER: "NUMERIC",
  INTEGER: "INTEGER",
  BINARY_INTEGER: "INTEGER",
  PLS_INTEGER: "INTEGER",
  SIMPLE_INTEGER: "INTEGER",
  NATURAL: "INTEGER",
  POSITIVE: "INTEGER",
  FLOAT: "FLOAT",
  REAL: "REAL",
  SMALLINT: "SMALLINT",
  NUMERIC: "NUMERIC",
  DECIMAL: "DECIMAL",

  // ── 日期时间 ──
  DATE: "DATE",
  TIMESTAMP: "TIMESTAMP",
  "TIMESTAMP WITH TIME ZONE": "TIMESTAMP_WITH_TIMEZONE",
  "TIMESTAMP WITH LOCAL TIME ZONE": "TIMESTAMP_WITH_TIMEZONE",

  // ── 二进制 ──
  BLOB: "BLOB",
  RAW: "VARBINARY",
  LONG_RAW: "LONGVARBINARY",

  // ── 布尔 ──
  BOOLEAN: "BOOLEAN",

  // ── 游标 / 其他 ──
  SYS_REFCURSOR: "CURSOR",
  ROWID: "VARCHAR",
  UROWID: "VARCHAR",
}
