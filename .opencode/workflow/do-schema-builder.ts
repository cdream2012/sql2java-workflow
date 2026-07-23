/**
 * do-schema-builder — DO 实体 + schema-h2.sql 确定性生成（零 LLM）
 *
 * scaffold 完成后由 engine 在 validatePhaseArtifact(scaffold) 内调用（仿 inventory 兜底
 * buildDependencyGraphFromIndex 的先例）。直接读上游 inventory.json + tables/*.json，
 * 按 §3.1 类型映射 + §4.1 命名生成 entity/*DO.java + src/test/resources/schema-h2.sql，
 * 落盘 projectRoot，返回 manifest 供 engine patch 进 scaffold.json.generated。
 *
 * 设计见 [[scaffold-input-aggregation]] 续：tables/sequences/views 全程不进 LLM 上下文，
 * scaffold-input.json 瘦身为 packages-only。DO/schema-h2 是机械活（查表规则），LLM 不增值。
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { getLogger } from "./workflow-logger"
import { safeWriteFile } from "./cross-platform"

/** 读 JSON 文件（不存在/解析失败返回 null）。镜像 workflow-engine.readJsonOrNull，保持自包含。 */
function readJsonOrNull(path: string): any {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, "utf-8")) } catch { return null }
}

/** manifest 元素：对齐 ScaffoldSchema.generated.entities {file, tableName} */
export interface DoEntityEntry { file: string; tableName: string }
export interface DoSchemaManifest {
  entities: DoEntityEntry[]
  h2SchemaFile: string
}

interface Column { name: string; plsqlType: string; nullable: boolean; isPrimaryKey?: boolean; defaultValue?: any }
interface TableJson { name: string; columns: Column[]; primaryKey?: string[] | { columns?: string[] } | null; foreignKeys?: any[] }

// ── 命名 ─────────────────────────────────────────────────────────────────────

/** 表名 → DO 类名：去 schema 前缀 → 去 T_ 前缀 → snake→PascalCase → + DO。
 *  §3.1 line 119 印证：gmo_clr_settle → GmoClrSettleDO；MFG_ERP.T_BOM_LINE → BomLineDO。 */
export function tableNameToClassName(tableName: string): string {
  let n = tableName.includes(".") ? tableName.split(".").slice(1).join(".") : tableName
  n = n.replace(/^T_/i, "")
  const pascal = n.toLowerCase().split(/[_\s]+/).filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("")
  return pascal + "DO"
}

/** 列名 → camelCase 字段名（snake_case 转 lowerCamelCase）。 */
function columnNameToField(col: string): string {
  const parts = col.toLowerCase().split(/[_\s]+/).filter(Boolean)
  return parts[0] + parts.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join("")
}

// ── 类型映射 §3.1 ─────────────────────────────────────────────────────────────

/** PL/SQL 类型 → Java 类型；返回 null 表示 UDT/未识别（跳过字段+注释）。 */
export function plsqlTypeToJava(plsqlType: string): string | null {
  const t = plsqlType.trim().toUpperCase()
  const m = /^([A-Z0-9_ ]+?)\s*(?:\((\d+)\s*(?:,\s*(\d+))?\))?$/.exec(t)
  const base = (m ? m[1] : t).trim()
  const p = m && m[2] != null ? parseInt(m[2], 10) : undefined
  const s = m && m[3] != null ? parseInt(m[3], 10) : 0

  if (/^(VARCHAR2|VARCHAR|CHAR|NCHAR|NVARCHAR2|CLOB|LONG|XMLTYPE)$/.test(base)) return "String"
  if (base === "NUMBER") {
    if (s > 0) return "BigDecimal"          // NUMBER(p,s) s>0 小数
    if (p == null) return "BigDecimal"       // NUMBER 无精度
    return "Long"                             // NUMBER(p) 整数
  }
  if (/^(INTEGER|INT|SMALLINT|BINARY_INTEGER|PLS_INTEGER)$/.test(base)) return "Long"
  if (/^(FLOAT|BINARY_FLOAT|BINARY_DOUBLE|DOUBLE|REAL)$/.test(base)) return "Double"
  if (base === "DATE") return "LocalDate"
  if (base.startsWith("TIMESTAMP")) {
    return base.includes("WITH TIME ZONE") ? "OffsetDateTime" : "LocalDateTime"
  }
  if (base === "BOOLEAN") return "Boolean"
  if (/^(BLOB|RAW|LONG RAW)$/.test(base)) return "byte[]"
  return null // UDT / 集合 / 未识别 → 跳过
}

/** 需要 import 的 Java 类型 → import 语句（按用到才加）。 */
const IMPORT_BY_TYPE: Record<string, string> = {
  BigDecimal: "java.math.BigDecimal",
  LocalDate: "java.time.LocalDate",
  LocalDateTime: "java.time.LocalDateTime",
  OffsetDateTime: "java.time.OffsetDateTime",
}

// ── DO .java 生成 ─────────────────────────────────────────────────────────────

function buildDoJava(table: TableJson, className: string, dateStr: string): string {
  const imports = new Set<string>(["lombok.Data", "com.baomidou.mybatisplus.annotation.TableName"])
  const fieldLines: string[] = []
  for (const col of table.columns ?? []) {
    const javaType = plsqlTypeToJava(col.plsqlType)
    if (!javaType) {
      fieldLines.push(`    // 列 ${col.name}（${col.plsqlType}）为 UDT/未识别类型，跳过字段生成`)
      continue
    }
    if (IMPORT_BY_TYPE[javaType]) imports.add(IMPORT_BY_TYPE[javaType])
    fieldLines.push(`    /** ${col.name} */`)
    fieldLines.push(`    private ${javaType} ${columnNameToField(col.name)};`)
  }
  const importBlock = [...imports].sort().map(i => `import ${i};`).join("\n")
  return [
    "package entity;",
    "",
    importBlock,
    "",
    "/**",
    ` * ${table.name} 数据对象`,
    " * <p>生成来源：表 " + table.name + "（引擎确定性生成，勿手改）</p>",
    " *",
    " * @author sql2java-workflow",
    " * @version 1.0",
    ` * @since ${dateStr}`,
    " */",
    "@Data",
    `@TableName("${table.name}")`,
    `public class ${className} {`,
    fieldLines.join("\n"),
    "}",
    "",
  ].join("\n")
}

// ── schema-h2.sql 生成 ────────────────────────────────────────────────────────

/** 归一化主键列名：兼容 string[] / {columns:[]} / isPrimaryKey 回退。 */
function pkColumns(table: TableJson): string[] {
  const pk = table.primaryKey
  if (Array.isArray(pk)) return pk as string[]
  if (pk && Array.isArray(pk.columns)) return pk.columns
  return (table.columns ?? []).filter(c => c.isPrimaryKey).map(c => c.name)
}

function schemaOf(tableName: string): string | null {
  return tableName.includes(".") ? tableName.split(".")[0] : null
}

function buildH2Schema(tables: TableJson[], sequences: any[], views: any[]): string {
  const lines: string[] = ["-- schema-h2.sql（引擎确定性生成，勿手改）", ""]
  // schema
  const schemas = new Set<string>()
  for (const t of tables) { const s = schemaOf(t.name); if (s) schemas.add(s) }
  for (const s of [...schemas].sort()) lines.push(`CREATE SCHEMA IF NOT EXISTS ${s};`)
  if (schemas.size) lines.push("")
  // tables
  for (const t of tables) {
    lines.push(`CREATE TABLE ${t.name} (`)
    const colLines: string[] = []
    for (const c of t.columns ?? []) {
      if (!plsqlTypeToJava(c.plsqlType)) {
        colLines.push(`  -- ${c.name}（${c.plsqlType}）UDT 列跳过`)
        continue
      }
      let line = `  ${c.name} ${c.plsqlType}`
      if (c.defaultValue != null && c.defaultValue !== "") line += ` DEFAULT ${c.defaultValue}`
      if (c.nullable === false) line += " NOT NULL"
      colLines.push(line)
    }
    const pk = pkColumns(t)
    if (pk.length) colLines.push(`  PRIMARY KEY (${pk.join(", ")})`)
    // 逗号分隔：注释行（-- 开头）与最后一行不加逗号，避免 UDT 注释吞掉分隔逗号
    const body = colLines.map((ln, i) => {
      if (ln.trimStart().startsWith("--")) return ln
      if (i === colLines.length - 1) return ln
      return ln + ","
    }).join("\n")
    lines.push(body)
    lines.push(");")
    lines.push("")
  }
  // sequences
  for (const seq of sequences ?? []) {
    if (!seq || !seq.name) continue
    const start = seq.startWith ?? 1
    const incr = seq.incrementBy ?? 1
    lines.push(`CREATE SEQUENCE IF NOT EXISTS ${seq.name} START WITH ${start} INCREMENT BY ${incr};`)
  }
  if (sequences?.length) lines.push("")
  // foreign keys
  for (const t of tables) {
    for (const fk of t.foreignKeys ?? []) {
      if (!fk || !fk.name) continue
      const cols = (fk.columns ?? []).join(", ")
      const refCols = (fk.refColumns ?? []).join(", ")
      lines.push(`ALTER TABLE ${t.name} ADD CONSTRAINT ${fk.name} FOREIGN KEY (${cols}) REFERENCES ${fk.refTable} (${refCols});`)
    }
  }
  // views（inventory 无 DDL body，跳过）
  for (const v of views ?? []) {
    if (v && v.name) lines.push(`-- view ${v.name} omitted（inventory 无 DDL body）`)
  }
  return lines.join("\n") + "\n"
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

/**
 * 读 inventory + tables，生成 entity/*DO.java + schema-h2.sql 到 projectRoot，
 * 返回 manifest（entities 清单 + h2SchemaFile 相对路径）。
 * 单表缺失/解析失败 → warn 跳过，不阻断。
 */
export function generateDoAndH2Schema(artifactsDir: string, projectRoot: string): DoSchemaManifest {
  const log = getLogger()
  const inv = readJsonOrNull(join(artifactsDir, "inventory.json"))
  if (!inv) {
    throw new Error(`inventory.json 缺失/不可解析：${join(artifactsDir, "inventory.json")}`)
  }
  const tableNames: string[] = Array.isArray(inv.tableNames) ? inv.tableNames : []
  const sequences: any[] = Array.isArray(inv.sequences) ? inv.sequences : []
  const views: any[] = Array.isArray(inv.views) ? inv.views : []

  const dateStr = new Date().toISOString().slice(0, 10)
  const entities: DoEntityEntry[] = []
  const tables: TableJson[] = []

  for (const tn of tableNames) {
    const tbl = readJsonOrNull(join(artifactsDir, "tables", `${tn}.json`)) as TableJson | null
    if (!tbl) {
      log.warn("[do-schema]", `tables/${tn}.json 缺失/不可解析，跳过`)
      continue
    }
    if (!Array.isArray(tbl.columns) || tbl.columns.length === 0) {
      log.warn("[do-schema]", `tables/${tn}.json 无 columns，跳过 DO 生成`)
      continue
    }
    const className = tableNameToClassName(tn)
    const relFile = `src/main/java/entity/${className}.java`
    safeWriteFile(join(projectRoot, relFile), buildDoJava(tbl, className, dateStr))
    entities.push({ file: relFile, tableName: tn })
    tables.push({ name: tbl.name ?? tn, columns: tbl.columns, primaryKey: tbl.primaryKey, foreignKeys: tbl.foreignKeys })
  }

  const h2Rel = "src/test/resources/schema-h2.sql"
  safeWriteFile(join(projectRoot, h2Rel), buildH2Schema(tables, sequences, views))

  log.info("[do-schema]", `生成 ${entities.length} DO + schema-h2.sql → ${projectRoot}`)
  return { entities, h2SchemaFile: h2Rel }
}
