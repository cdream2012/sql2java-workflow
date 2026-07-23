/**
 * type-mappings.test.ts — PL/SQL → Java/JDBC 类型映射校验
 */

import { describe, it, expect } from "vitest"
import { PLSQL_TO_JAVA, PLSQL_TO_JDBC } from "@workflow/type-mappings"

describe("PLSQL_TO_JAVA", () => {
  it("VARCHAR2 → String", () => {
    expect(PLSQL_TO_JAVA.VARCHAR2).toBe("String")
  })

  it("NVARCHAR2 → String", () => {
    expect(PLSQL_TO_JAVA.NVARCHAR2).toBe("String")
  })

  it("CHAR → String", () => {
    expect(PLSQL_TO_JAVA.CHAR).toBe("String")
  })

  it("CLOB → String", () => {
    expect(PLSQL_TO_JAVA.CLOB).toBe("String")
  })

  it("NUMBER → BigDecimal", () => {
    expect(PLSQL_TO_JAVA.NUMBER).toBe("BigDecimal")
  })

  it("INTEGER → Integer", () => {
    expect(PLSQL_TO_JAVA.INTEGER).toBe("Integer")
  })

  it("DATE → LocalDate", () => {
    expect(PLSQL_TO_JAVA.DATE).toBe("LocalDate")
  })

  it("TIMESTAMP → LocalDateTime", () => {
    expect(PLSQL_TO_JAVA.TIMESTAMP).toBe("LocalDateTime")
  })

  it("BOOLEAN → Boolean", () => {
    expect(PLSQL_TO_JAVA.BOOLEAN).toBe("Boolean")
  })

  it("BLOB → byte[]", () => {
    expect(PLSQL_TO_JAVA.BLOB).toBe("byte[]")
  })

  it("SYS_REFCURSOR → List<Map<String,Object>>", () => {
    expect(PLSQL_TO_JAVA.SYS_REFCURSOR).toBe("List<Map<String,Object>>")
  })

  it("PL/SQL integer subtypes → Integer", () => {
    expect(PLSQL_TO_JAVA.BINARY_INTEGER).toBe("Integer")
    expect(PLSQL_TO_JAVA.PLS_INTEGER).toBe("Integer")
    expect(PLSQL_TO_JAVA.SIMPLE_INTEGER).toBe("Integer")
    expect(PLSQL_TO_JAVA.NATURAL).toBe("Integer")
    expect(PLSQL_TO_JAVA.POSITIVE).toBe("Integer")
  })

  it("TIMESTAMP WITH TIME ZONE → OffsetDateTime", () => {
    expect(PLSQL_TO_JAVA["TIMESTAMP WITH TIME ZONE"]).toBe("OffsetDateTime")
  })

  it("TIMESTAMP WITH LOCAL TIME ZONE → OffsetDateTime", () => {
    expect(PLSQL_TO_JAVA["TIMESTAMP WITH LOCAL TIME ZONE"]).toBe("OffsetDateTime")
  })

  it("FLOAT → Double", () => {
    expect(PLSQL_TO_JAVA.FLOAT).toBe("Double")
  })

  it("REAL → Float", () => {
    expect(PLSQL_TO_JAVA.REAL).toBe("Float")
  })
})

describe("PLSQL_TO_JDBC", () => {
  it("VARCHAR2 → VARCHAR", () => {
    expect(PLSQL_TO_JDBC.VARCHAR2).toBe("VARCHAR")
  })

  it("NUMBER → NUMERIC", () => {
    expect(PLSQL_TO_JDBC.NUMBER).toBe("NUMERIC")
  })

  it("DATE → DATE", () => {
    expect(PLSQL_TO_JDBC.DATE).toBe("DATE")
  })

  it("TIMESTAMP → TIMESTAMP", () => {
    expect(PLSQL_TO_JDBC.TIMESTAMP).toBe("TIMESTAMP")
  })

  it("BOOLEAN → BOOLEAN", () => {
    expect(PLSQL_TO_JDBC.BOOLEAN).toBe("BOOLEAN")
  })

  it("BLOB → BLOB", () => {
    expect(PLSQL_TO_JDBC.BLOB).toBe("BLOB")
  })

  it("SYS_REFCURSOR → CURSOR", () => {
    expect(PLSQL_TO_JDBC.SYS_REFCURSOR).toBe("CURSOR")
  })

  it("TIMESTAMP WITH TIME ZONE → TIMESTAMP_WITH_TIMEZONE", () => {
    expect(PLSQL_TO_JDBC["TIMESTAMP WITH TIME ZONE"]).toBe("TIMESTAMP_WITH_TIMEZONE")
  })

  it("TIMESTAMP WITH LOCAL TIME ZONE → TIMESTAMP_WITH_TIMEZONE", () => {
    expect(PLSQL_TO_JDBC["TIMESTAMP WITH LOCAL TIME ZONE"]).toBe("TIMESTAMP_WITH_TIMEZONE")
  })

  it("PL/SQL integer subtypes → INTEGER", () => {
    expect(PLSQL_TO_JDBC.BINARY_INTEGER).toBe("INTEGER")
    expect(PLSQL_TO_JDBC.PLS_INTEGER).toBe("INTEGER")
    expect(PLSQL_TO_JDBC.SIMPLE_INTEGER).toBe("INTEGER")
  })
})

describe("PLSQL_TO_JAVA 和 PLSQL_TO_JDBC 一致性", () => {
  it("JDBC map 是 JAVA map 的子集（JDBC 可少于 JAVA）", () => {
    const javaKeys = new Set(Object.keys(PLSQL_TO_JAVA))
    for (const key of Object.keys(PLSQL_TO_JDBC)) {
      expect(javaKeys.has(key), `PLSQL_TO_JDBC key "${key}" missing from PLSQL_TO_JAVA`).toBe(true)
    }
  })

  it("JAVA map 中有但 JDBC map 中没有的 key 是已知例外", () => {
    const jdbcKeys = new Set(Object.keys(PLSQL_TO_JDBC))
    const javaOnly = Object.keys(PLSQL_TO_JAVA).filter(k => !jdbcKeys.has(k))
    // TIMESTAMP(6) 等价于 TIMESTAMP，JDBC 映射可复用 TIMESTAMP 条目
    expect(javaOnly).toEqual(["TIMESTAMP(6)"])
  })

  it("所有 key 都有非空映射值", () => {
    for (const [key, val] of Object.entries(PLSQL_TO_JAVA)) {
      expect(val, `PLSQL_TO_JAVA[${key}] should not be empty`).toBeTruthy()
    }
    for (const [key, val] of Object.entries(PLSQL_TO_JDBC)) {
      expect(val, `PLSQL_TO_JDBC[${key}] should not be empty`).toBeTruthy()
    }
  })
})
