/**
 * do-schema-builder.test.ts — DO 实体 + schema-h2.sql 确定性生成单测
 *
 * 覆盖：
 *   - 表名→DO 类名（去 schema+T_ 前缀、snake→Pascal、+DO）
 *   - PL/SQL→Java 类型映射（§3.1）：NUMBER 整数/小数/无精度、VARCHAR2、DATE、TIMESTAMP、BLOB、UDT 跳过
 *   - 列名→camelCase 字段
 *   - schema-h2 DDL：CREATE SCHEMA/TABLE、PK（兼容 string[] 与 {columns:[]}）、NOT NULL、DEFAULT、FK、序列、视图跳过
 *   - manifest 结构对齐 ScaffoldSchema.generated.entities {file, tableName} + h2SchemaFile
 *   - 单表缺失容错
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { generateDoAndH2Schema, tableNameToClassName, plsqlTypeToJava } from "@workflow/do-schema-builder"

describe("tableNameToClassName", () => {
  it("去 schema 前缀 + T_ 前缀 + snake→Pascal + DO", () => {
    expect(tableNameToClassName("MFG_ERP.T_BOM_LINE")).toBe("BomLineDO")
    expect(tableNameToClassName("MFG_ERP.T_ITEM")).toBe("ItemDO")
  })
  it("无 T_ 前缀的表（§3.1 %ROWTYPE 印证）", () => {
    expect(tableNameToClassName("gmo_clr_settle")).toBe("GmoClrSettleDO")
  })
  it("无 schema 前缀", () => {
    expect(tableNameToClassName("T_SALES_ORDER")).toBe("SalesOrderDO")
  })
})

describe("plsqlTypeToJava (§3.1)", () => {
  it("NUMBER 整数→Long，小数→BigDecimal，无精度→BigDecimal", () => {
    expect(plsqlTypeToJava("NUMBER(18)")).toBe("Long")
    expect(plsqlTypeToJava("NUMBER(18,6)")).toBe("BigDecimal")
    expect(plsqlTypeToJava("NUMBER")).toBe("BigDecimal")
    expect(plsqlTypeToJava("NUMBER(2)")).toBe("Long")
  })
  it("字符串族→String", () => {
    expect(plsqlTypeToJava("VARCHAR2(40)")).toBe("String")
    expect(plsqlTypeToJava("CHAR(1)")).toBe("String")
    expect(plsqlTypeToJava("CLOB")).toBe("String")
  })
  it("日期时间", () => {
    expect(plsqlTypeToJava("DATE")).toBe("LocalDate")
    expect(plsqlTypeToJava("TIMESTAMP(6)")).toBe("LocalDateTime")
    expect(plsqlTypeToJava("TIMESTAMP WITH TIME ZONE")).toBe("OffsetDateTime")
  })
  it("二进制/布尔/浮点", () => {
    expect(plsqlTypeToJava("BLOB")).toBe("byte[]")
    expect(plsqlTypeToJava("RAW(200)")).toBe("byte[]")
    expect(plsqlTypeToJava("BOOLEAN")).toBe("Boolean")
    expect(plsqlTypeToJava("FLOAT")).toBe("Double")
  })
  it("UDT/未识别→null（跳过）", () => {
    expect(plsqlTypeToJava("t_dimension")).toBeNull()
    expect(plsqlTypeToJava("t_tag_varray")).toBeNull()
    expect(plsqlTypeToJava("XMLTYPE")).toBe("String")
  })
})

describe("generateDoAndH2Schema", () => {
  let dir: string
  let projectRoot: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "do-schema-inv-"))
    projectRoot = mkdtempSync(join(tmpdir(), "do-schema-proj-"))
    mkdirSync(join(dir, "tables"), { recursive: true })

    writeFileSync(join(dir, "inventory.json"), JSON.stringify({
      tableNames: ["MFG_ERP.T_ITEM", "MFG_ERP.T_BOM_LINE", "MFG_ERP.T_CODE_DICT"],
      sequences: [{ name: "MFG_ERP.SEQ_ITEM_ID", startWith: 10000, incrementBy: 1 }],
      views: [{ name: "MFG_ERP.V_ITEM_FULL", columns: ["c1"] }],
    }))

    // string[] primaryKey
    writeFileSync(join(dir, "tables", "MFG_ERP.T_ITEM.json"), JSON.stringify({
      name: "MFG_ERP.T_ITEM",
      columns: [
        { name: "ITEM_ID", plsqlType: "NUMBER(18)", nullable: false, isPrimaryKey: true, defaultValue: null },
        { name: "ITEM_CODE", plsqlType: "VARCHAR2(40)", nullable: false, isPrimaryKey: false, defaultValue: null },
        { name: "STD_COST", plsqlType: "NUMBER(20,6)", nullable: false, defaultValue: "0" },
        { name: "DIM", plsqlType: "t_dimension", nullable: true, defaultValue: null }, // UDT 跳过
      ],
      primaryKey: ["ITEM_ID"],
      foreignKeys: [],
    }))

    // {columns:[]} primaryKey + 外键
    writeFileSync(join(dir, "tables", "MFG_ERP.T_BOM_LINE.json"), JSON.stringify({
      name: "MFG_ERP.T_BOM_LINE",
      columns: [
        { name: "LINE_ID", plsqlType: "NUMBER(18)", nullable: false, isPrimaryKey: true, defaultValue: null },
        { name: "BOM_ID", plsqlType: "NUMBER(18)", nullable: false, isPrimaryKey: false, defaultValue: null },
        { name: "CREATED_AT", plsqlType: "TIMESTAMP(6)", nullable: false, defaultValue: "CURRENT_TIMESTAMP" },
      ],
      primaryKey: { columns: ["LINE_ID"] },
      foreignKeys: [{ name: "FK_BOMLINE_HEADER", columns: ["BOM_ID"], refTable: "MFG_ERP.T_BOM_HEADER", refColumns: ["BOM_ID"] }],
    }))

    // 复合主键
    writeFileSync(join(dir, "tables", "MFG_ERP.T_CODE_DICT.json"), JSON.stringify({
      name: "MFG_ERP.T_CODE_DICT",
      columns: [
        { name: "DICT_TYPE", plsqlType: "VARCHAR2(32)", nullable: false, isPrimaryKey: true, defaultValue: null },
        { name: "CODE", plsqlType: "VARCHAR2(64)", nullable: false, isPrimaryKey: true, defaultValue: null },
      ],
      primaryKey: ["DICT_TYPE", "CODE"],
      foreignKeys: [],
    }))
  })

  it("生成 entity/*DO.java + schema-h2.sql，返回 manifest", () => {
    const manifest = generateDoAndH2Schema(dir, projectRoot)
    expect(manifest.entities.map(e => e.file).sort()).toEqual([
      "src/main/java/entity/BomLineDO.java",
      "src/main/java/entity/CodeDictDO.java",
      "src/main/java/entity/ItemDO.java",
    ])
    expect(manifest.entities.map(e => e.tableName).sort()).toEqual([
      "MFG_ERP.T_BOM_LINE", "MFG_ERP.T_CODE_DICT", "MFG_ERP.T_ITEM",
    ])
    expect(manifest.h2SchemaFile).toBe("src/test/resources/schema-h2.sql")
    expect(existsSync(join(projectRoot, "src/main/java/entity/ItemDO.java"))).toBe(true)
    expect(existsSync(join(projectRoot, "src/test/resources/schema-h2.sql"))).toBe(true)
  })

  it("DO .java 含 @Data + @TableName + 字段类型正确 + UDT 跳过", () => {
    const java = readFileSync(join(projectRoot, "src/main/java/entity/ItemDO.java"), "utf-8")
    expect(java).toContain("package entity;")
    expect(java).toContain("import lombok.Data;")
    expect(java).toContain('import com.baomidou.mybatisplus.annotation.TableName;')
    expect(java).toContain('@TableName("MFG_ERP.T_ITEM")')
    expect(java).toContain("public class ItemDO")
    expect(java).toContain("private Long itemId;")
    expect(java).toContain("private String itemCode;")
    expect(java).toContain("private BigDecimal stdCost;")
    // UDT 列跳过（无 dim 字段，有 DIM 注释）
    expect(java).toContain("DIM")
    expect(java).not.toMatch(/private\s+\S+\s+dim;/)
  })

  it("schema-h2.sql 含 schema/table/PK/NOT NULL/DEFAULT/FK/序列/视图跳过", () => {
    const sql = readFileSync(join(projectRoot, "src/test/resources/schema-h2.sql"), "utf-8")
    expect(sql).toContain("CREATE SCHEMA IF NOT EXISTS MFG_ERP;")
    expect(sql).toContain("CREATE TABLE MFG_ERP.T_ITEM (")
    expect(sql).toContain("ITEM_ID NUMBER(18) NOT NULL")
    expect(sql).toContain("STD_COST NUMBER(20,6) DEFAULT 0 NOT NULL")
    expect(sql).toContain("PRIMARY KEY (ITEM_ID)")
    expect(sql).toContain("PRIMARY KEY (DICT_TYPE, CODE)") // 复合 PK
    expect(sql).toContain("CREATED_AT TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP NOT NULL")
    expect(sql).toContain("CREATE SEQUENCE IF NOT EXISTS MFG_ERP.SEQ_ITEM_ID START WITH 10000 INCREMENT BY 1;")
    expect(sql).toContain("ALTER TABLE MFG_ERP.T_BOM_LINE ADD CONSTRAINT FK_BOMLINE_HEADER FOREIGN KEY (BOM_ID) REFERENCES MFG_ERP.T_BOM_HEADER (BOM_ID);")
    expect(sql).toContain("-- view MFG_ERP.V_ITEM_FULL omitted")
    // UDT 列跳过注释
    expect(sql).toContain("DIM")
  })

  it("inventory.json 缺失时抛错", () => {
    const empty = mkdtempSync(join(tmpdir(), "do-schema-empty-"))
    expect(() => generateDoAndH2Schema(empty, projectRoot)).toThrow(/inventory\.json/)
  })
})
