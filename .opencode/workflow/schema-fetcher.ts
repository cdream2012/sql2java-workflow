/**
 * Schema Fetcher — 数据库 Schema 自动获取（PostgreSQL / GaussDB）
 *
 * 在工作流启动前的预检步骤：当发现 db.properties 数据库配置时，
 * 连接 PostgreSQL/GaussDB 数据库提取 schema 元数据，生成 DDL 文件。
 *
 * 触发条件：sourcePath 下存在 db.properties 或通过 --db_conf 指定配置文件。
 * 无论是否已有 PL/SQL 文件，只要找到配置就会拉取 schema。
 *
 * 设计原则：
 * - 纯前置步骤，不侵入 workflow phase 链
 * - 动态 import，不使用时不加载 pg
 * - 通过 pg 驱动（libpq wire protocol）连接，兼容 PostgreSQL 与 GaussDB(openGauss)
 * - 生成的 DDL 为 PostgreSQL 语法；视图/触发器用 pg_get_*def 原样返回
 *   （GaussDB Oracle 兼容模式下天然为 PL/SQL 语法）
 * - 配置文件使用 properties 格式（db.properties）
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { atomicRename, safeRm } from "./cross-platform"
import { GENERATED_OUTPUT_DIR, GENERATED_MARKER, GENERATED_MARKER_ID } from "./constants"
import { getLogger } from "./workflow-logger"

// ── 内部配置类型 ──────────────────────────────────────────────────────────

/** 从 db.properties 解析后的内部配置结构 */
interface DbConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
  schema: string                 // 默认 "public"
  ssl?: boolean                  // 由 url ?sslmode= 推导
  connectionTimeoutMillis?: number
  statementTimeoutMillis?: number
  fetchTables?: boolean
  fetchTriggers?: boolean
  fetchViews?: boolean
  fetchSequences?: boolean
  fetchObjectTypes?: boolean
  tableFilter?: string
  triggerFilter?: string
  viewFilter?: string
  sequenceFilter?: string
  typeFilter?: string
}

// ── 元数据类型 ──────────────────────────────────────────────────────────────

interface PgColumn {
  tableName: string
  columnName: string
  dataType: string               // information_schema.data_type（如 "character varying"）
  udtName: string                // 实际类型名（如 "varchar"、枚举/复合类型名、"_int4" 数组）
  charMaxLength: number | null
  numericPrecision: number | null
  numericScale: number | null
  datetimePrecision: number | null
  nullable: string               // "YES" | "NO"
  columnDefault: string | null
  ordinalPosition: number
  identityGeneration: string | null  // "ALWAYS" | "BY DEFAULT" | null（非 identity 列）
}

interface PgConstraint {
  conname: string
  contype: string                // p=PK, u=Unique, f=FK, c=Check
  tableName: string
  definition: string             // pg_get_constraintdef 返回的定义文本
}

interface PgTrigger {
  triggerName: string
  definition: string             // pg_get_triggerdef 返回的完整 CREATE TRIGGER 文本
}

interface PgView {
  viewName: string
  definition: string             // pg_views.definition（SELECT 体）
}

interface PgSequence {
  sequenceName: string
  dataType: string
  startValue: string | null
  minValue: string | null
  maxValue: string | null
  increment: string | null
  cycleOption: string            // "YES" | "NO"
  cacheSize: number | null       // pg_sequences.cache_size；回退路径下为 null
}

interface PgEnumValue {
  label: string
}

interface PgCompositeField {
  attname: string
  dataType: string
}

interface PgObjectType {
  typeName: string
  typtype: string                // c=composite, e=enum, d=domain
  // enum
  enumLabels?: PgEnumValue[]
  // composite
  compositeFields?: PgCompositeField[]
  // domain
  baseType?: string | null
  notNull?: boolean
  defaultExpr?: string | null
  checkConstraints?: string[]    // pg_get_constraintdef 文本
}

interface PgTableComment {
  tableName: string
  comments: string
}

interface PgColumnComment {
  tableName: string
  columnName: string
  comments: string
}

export interface SchemaFetchResult {
  tablesFetched: number
  triggersFetched: number
  viewsFetched: number
  sequencesFetched: number
  objectTypesFetched: number
  outputDir: string
}

// ── 配置加载（db.properties — properties 格式）──────────────────────────────

/**
 * 解析 properties 文本为键值 Map。
 *
 * 规则：
 * - `#` 或 `!` 开头为注释，跳过
 * - 空行跳过
 * - 以第一个 `=` 切分 key/value（key 不含 `=`）
 * - key/value 均 trim，值不去引号
 */
function parseProperties(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === "") continue
    map.set(key, value)
  }
  return map
}

/**
 * 解析 PostgreSQL/GaussDB JDBC URL 为连接参数。
 *
 * 支持前缀：jdbc:postgresql://、jdbc:opengauss://、jdbc:gaussdb://
 * 格式：jdbc:<dialect>://host[:port]/database[?sslmode=...]
 *
 * 返回 host/port/database 以及可选的 sslmode。
 */
export function parsePgJdbcUrl(jdbcUrl: string): {
  host: string
  port: number
  database: string
  sslmode?: string
} {
  const m = jdbcUrl.match(/^jdbc:(?:postgresql|opengauss|gaussdb):\/\/([^/?]+)/i)
  if (!m) {
    throw new Error(
      `无效的 JDBC URL（需 jdbc:postgresql://host:port/db 或 jdbc:opengauss://...）: ${jdbcUrl}`,
    )
  }
  const authority = m[1]
  const slash = jdbcUrl.indexOf("/", m[0].length)
  const database = slash >= 0 ? jdbcUrl.slice(slash + 1) : ""
  const queryIdx = database.indexOf("?")
  let sslmode: string | undefined
  let db = database
  if (queryIdx >= 0) {
    db = database.slice(0, queryIdx)
    const qs = database.slice(queryIdx + 1)
    for (const pair of qs.split("&")) {
      const [k, v] = pair.split("=", 2)
      if (k === "sslmode") sslmode = v
    }
  }

  let host = authority
  let port = 5432
  const colon = authority.lastIndexOf(":")
  // 注意排除 IPv6 字面量 [::1] —— 此处用 lastIndexOf(':') 并校验冒号后为纯数字端口
  if (colon > 0 && /^\d+$/.test(authority.slice(colon + 1))) {
    host = authority.slice(0, colon)
    port = parseInt(authority.slice(colon + 1), 10)
  }
  // 去除 IPv6 方括号
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1)

  if (!db) {
    throw new Error(`JDBC URL 缺少数据库名: ${jdbcUrl}`)
  }
  return { host, port, database: db, sslmode }
}

/** 布尔解析：仅 "false"（不区分大小写）为 false，其余/缺省为 fallback */
function parseBool(val: string | undefined, fallback: boolean): boolean {
  if (val == null || val === "") return fallback
  return val.toLowerCase() !== "false"
}

/**
 * 从 db.properties 文本解析配置。
 *
 * 必填：db.url、db.username（或 db.user）、db.password
 * 可选：db.driver（忽略，非 postgres 驱动仅 warning）、db.connectTimeout（秒）、
 *      db.socketTimeout（秒）、db.schema（默认 public）、
 *      db.tableFilter/viewFilter/sequenceFilter/triggerFilter/typeFilter（SQL LIKE）、
 *      db.fetchTables/fetchTriggers/fetchViews/fetchSequences/fetchObjectTypes（默认 true）
 */
function parseDbProperties(text: string, filePath: string): DbConfig {
  const props = parseProperties(text)

  const url = props.get("db.url")
  if (!url) {
    throw new Error(`db.properties 缺少 db.url: ${filePath}`)
  }
  const user = props.get("db.username") ?? props.get("db.user")
  if (!user) {
    throw new Error(`db.properties 缺少 db.username: ${filePath}`)
  }
  const password = props.get("db.password")
  if (password == null) {
    throw new Error(`db.properties 缺少 db.password: ${filePath}`)
  }

  const driver = props.get("db.driver")
  if (driver && !/postgres/i.test(driver)) {
    getLogger().warn(
      "[schema-fetcher]",
      `db.driver=${driver} 非 PostgreSQL 驱动，将忽略（pg 驱动不需要 JDBC driver class）`,
    )
  }

  const parsed = parsePgJdbcUrl(url)

  const config: DbConfig = {
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user,
    password,
    schema: props.get("db.schema") || "public",
  }

  if (parsed.sslmode) {
    // require/prefer/verify-ca/verify-full 需要 SSL；disable/allow 不强制
    config.ssl = parsed.sslmode !== "disable" && parsed.sslmode !== "allow"
  }

  const connectTimeout = props.get("db.connectTimeout")
  if (connectTimeout) {
    const secs = Number(connectTimeout)
    if (Number.isFinite(secs) && secs > 0) config.connectionTimeoutMillis = secs * 1000
  }

  const socketTimeout = props.get("db.socketTimeout")
  if (socketTimeout) {
    const secs = Number(socketTimeout)
    if (Number.isFinite(secs) && secs > 0) config.statementTimeoutMillis = secs * 1000
  }

  // 名称过滤
  const filters: Array<[keyof DbConfig, string]> = [
    ["tableFilter", "db.tableFilter"],
    ["triggerFilter", "db.triggerFilter"],
    ["viewFilter", "db.viewFilter"],
    ["sequenceFilter", "db.sequenceFilter"],
    ["typeFilter", "db.typeFilter"],
  ]
  for (const [field, key] of filters) {
    const v = props.get(key)
    if (v) (config as Record<string, unknown>)[field as string] = v
  }

  // 拉取开关
  config.fetchTables = parseBool(props.get("db.fetchTables"), true)
  config.fetchTriggers = parseBool(props.get("db.fetchTriggers"), true)
  config.fetchViews = parseBool(props.get("db.fetchViews"), true)
  config.fetchSequences = parseBool(props.get("db.fetchSequences"), true)
  config.fetchObjectTypes = parseBool(props.get("db.fetchObjectTypes"), true)

  return config
}

/**
 * 加载 db.properties 数据库配置。
 *
 * 发现顺序（优先级从高到低）：
 * 1. dbConfPath 参数（来自 --db_conf 命令行参数）— 不存在时报错
 * 2. sourcePath/db.properties（项目根目录自动发现）
 *
 * 返回 null 表示无配置文件（DDL-only 模式）。
 */
export function loadDbConfig(dbConfPath?: string, sourcePath?: string): DbConfig | null {
  // 显式指定路径时，文件必须存在
  if (dbConfPath) {
    if (!existsSync(dbConfPath)) {
      throw new Error(`指定的数据库配置文件不存在: ${dbConfPath}`)
    }
    let raw: string
    try {
      raw = readFileSync(dbConfPath, "utf-8")
    } catch (e: any) {
      throw new Error(`无法读取 db.properties: ${e.message}`)
    }
    return parseDbProperties(raw, dbConfPath)
  }

  // 自动发现
  if (sourcePath) {
    const autoPath = join(sourcePath, "db.properties")
    if (!existsSync(autoPath)) return null
    let raw: string
    try {
      raw = readFileSync(autoPath, "utf-8")
    } catch (e: any) {
      throw new Error(`无法读取 db.properties: ${e.message}`)
    }
    return parseDbProperties(raw, autoPath)
  }

  return null
}

// ── 连接管理 ──────────────────────────────────────────────────────────────

/**
 * 解析密码：支持 "env:VAR_NAME" 引用环境变量
 */
function resolvePassword(password: string): string {
  if (password.startsWith("env:")) {
    const envVar = password.slice(4)
    const value = process.env[envVar]
    if (!value) {
      throw new Error(`环境变量 ${envVar} 未设置（db.properties password 引用）`)
    }
    return value
  }
  return password
}

// ── PostgreSQL 元数据查询 ──────────────────────────────────────────────────

// pg.Client 动态加载，宽松类型（避免对可选依赖做强类型耦合）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PgClient = any

/**
 * 查询表列定义
 */
async function fetchColumns(
  client: PgClient,
  schema: string,
  tableFilter: string | undefined,
): Promise<PgColumn[]> {
  const sql = `
    SELECT c.table_name, c.column_name, c.data_type, c.udt_name,
           c.character_maximum_length, c.numeric_precision, c.numeric_scale,
           c.datetime_precision, c.is_nullable, c.column_default, c.ordinal_position,
           c.identity_generation
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = $1
       AND t.table_type = 'BASE TABLE'
       ${tableFilter ? "AND c.table_name LIKE $2" : ""}
     ORDER BY c.table_name, c.ordinal_position`

  const params = tableFilter ? [schema, tableFilter] : [schema]
  const result = await client.query(sql, params)
  return result.rows.map((r: Record<string, unknown>) => ({
    tableName: r.table_name as string,
    columnName: r.column_name as string,
    dataType: r.data_type as string,
    udtName: r.udt_name as string,
    charMaxLength: r.character_maximum_length as number | null,
    numericPrecision: r.numeric_precision as number | null,
    numericScale: r.numeric_scale as number | null,
    datetimePrecision: r.datetime_precision as number | null,
    nullable: r.is_nullable as string,
    columnDefault: r.column_default as string | null,
    ordinalPosition: r.ordinal_position as number,
    identityGeneration: (r.identity_generation as string | null) ?? null,
  }))
}

/**
 * 查询约束（PK/UK/FK/CHECK）
 * 使用 pg_get_constraintdef 直接获取定义文本，无需列级重建。
 */
async function fetchConstraints(
  client: PgClient,
  schema: string,
  tableFilter: string | undefined,
): Promise<PgConstraint[]> {
  const sql = `
    SELECT c.conname, c.contype, t.relname AS table_name,
           pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = $1
       AND c.contype IN ('p', 'u', 'f', 'c')
       ${tableFilter ? "AND t.relname LIKE $2" : ""}
     ORDER BY t.relname, c.contype, c.conname`

  const params = tableFilter ? [schema, tableFilter] : [schema]
  const result = await client.query(sql, params)
  return result.rows.map((r: Record<string, unknown>) => ({
    conname: r.conname as string,
    contype: r.contype as string,
    tableName: r.table_name as string,
    definition: r.definition as string,
  }))
}

/**
 * 查询表和列注释
 */
async function fetchComments(
  client: PgClient,
  schema: string,
  tableFilter: string | undefined,
): Promise<{ tableComments: PgTableComment[]; columnComments: PgColumnComment[] }> {
  const filter = tableFilter ? "AND c.relname LIKE $2" : ""
  const params = tableFilter ? [schema, tableFilter] : [schema]

  const tableCommentSql = `
    SELECT c.relname AS table_name, d.description
      FROM pg_description d
      JOIN pg_class c ON c.oid = d.objoid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND d.objsubid = 0
       AND d.classoid = 'pg_class'::regclass
       AND c.relkind IN ('r', 'p')
       ${filter}`

  const colCommentSql = `
    SELECT c.relname AS table_name, a.attname AS column_name, d.description
      FROM pg_description d
      JOIN pg_class c ON c.oid = d.objoid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
     WHERE n.nspname = $1 AND d.objsubid > 0
       AND d.classoid = 'pg_class'::regclass
       AND c.relkind IN ('r', 'p')
       AND NOT a.attisdropped
       ${filter}`

  // 顺序执行：单连接上避免并发查询
  const tcResult = await client.query(tableCommentSql, params)
  const ccResult = await client.query(colCommentSql, params)

  return {
    tableComments: tcResult.rows.map((r: Record<string, unknown>) => ({
      tableName: r.table_name as string,
      comments: r.description as string,
    })),
    columnComments: ccResult.rows.map((r: Record<string, unknown>) => ({
      tableName: r.table_name as string,
      columnName: r.column_name as string,
      comments: r.description as string,
    })),
  }
}

/**
 * 查询视图（pg_views.definition 原样返回）
 */
async function fetchViews(
  client: PgClient,
  schema: string,
  viewFilter: string | undefined,
): Promise<PgView[]> {
  const sql = `
    SELECT viewname AS view_name, definition
      FROM pg_views
     WHERE schemaname = $1
       ${viewFilter ? "AND viewname LIKE $2" : ""}
     ORDER BY viewname`

  const params = viewFilter ? [schema, viewFilter] : [schema]
  const result = await client.query(sql, params)
  return result.rows.map((r: Record<string, unknown>) => ({
    viewName: r.view_name as string,
    definition: (r.definition as string) || "",
  }))
}

/**
 * 查询序列
 *
 * 优先用 pg_sequences 视图（PG 10+，含 cache_size）；不可用时（如老版本/GaussDB 缺该视图）
 * 回退 information_schema.sequences（无 cache_size，cacheSize 置 null）。
 */
async function fetchSequences(
  client: PgClient,
  schema: string,
  sequenceFilter: string | undefined,
): Promise<PgSequence[]> {
  const params = sequenceFilter ? [schema, sequenceFilter] : [schema]

  try {
    const sql = `
      SELECT sequencename AS sequence_name, data_type,
             start_value, min_value, max_value, increment_by, cycle, cache_size
        FROM pg_sequences
       WHERE schemaname = $1
         ${sequenceFilter ? "AND sequencename LIKE $2" : ""}
       ORDER BY sequencename`
    const result = await client.query(sql, params)
    return result.rows.map((r: Record<string, unknown>) => ({
      sequenceName: r.sequence_name as string,
      dataType: r.data_type as string,
      startValue: r.start_value != null ? String(r.start_value) : null,
      minValue: r.min_value != null ? String(r.min_value) : null,
      maxValue: r.max_value != null ? String(r.max_value) : null,
      increment: r.increment_by != null ? String(r.increment_by) : null,
      cycleOption: r.cycle ? "YES" : "NO",
      cacheSize: (r.cache_size as number | null) ?? null,
    }))
  } catch (e: any) {
    // pg_sequences 不可用（关系不存在等）→ 回退 information_schema
    getLogger().warn(
      "[schema-fetcher]",
      `pg_sequences 不可用，回退 information_schema.sequences（序列 cache 将丢失）: ${e.message}`,
    )
    const sql = `
      SELECT sequence_name, data_type, start_value, minimum_value,
             maximum_value, increment, cycle_option
        FROM information_schema.sequences
       WHERE sequence_schema = $1
         ${sequenceFilter ? "AND sequence_name LIKE $2" : ""}
       ORDER BY sequence_name`
    const result = await client.query(sql, params)
    return result.rows.map((r: Record<string, unknown>) => ({
      sequenceName: r.sequence_name as string,
      dataType: r.data_type as string,
      startValue: r.start_value != null ? String(r.start_value) : null,
      minValue: r.minimum_value != null ? String(r.minimum_value) : null,
      maxValue: r.maximum_value != null ? String(r.maximum_value) : null,
      increment: r.increment != null ? String(r.increment) : null,
      cycleOption: r.cycle_option === "YES" ? "YES" : "NO",
      cacheSize: null,
    }))
  }
}

/**
 * 查询触发器（pg_get_triggerdef 原样返回完整 CREATE TRIGGER 文本）
 */
async function fetchTriggers(
  client: PgClient,
  schema: string,
  triggerFilter: string | undefined,
): Promise<PgTrigger[]> {
  const sql = `
    SELECT t.tgname AS trigger_name, pg_get_triggerdef(t.oid, true) AS definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1
       AND NOT t.tgisinternal
       ${triggerFilter ? "AND t.tgname LIKE $2" : ""}
     ORDER BY t.tgname`

  const params = triggerFilter ? [schema, triggerFilter] : [schema]
  const result = await client.query(sql, params)
  return result.rows.map((r: Record<string, unknown>) => ({
    triggerName: r.trigger_name as string,
    definition: (r.definition as string) || "",
  }))
}

/**
 * 查询自定义类型（composite / enum / domain）
 * PG 无存储源码，按 typtype 分支拉取结构后重建 DDL。
 */
async function fetchObjectTypes(
  client: PgClient,
  schema: string,
  typeFilter: string | undefined,
): Promise<PgObjectType[]> {
  // 主查询：列出类型，过滤掉表行类型（typrelid 指向 relkind='r' 的是真实表，非独立复合类型）
  const listSql = `
    SELECT t.typname AS type_name, t.typtype,
           format_type(t.typbasetype, t.typtypmod) AS base_type,
           t.typnotnull, t.typdefault,
           t.typrelid
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      LEFT JOIN pg_class rc ON rc.oid = t.typrelid
     WHERE n.nspname = $1
       AND t.typtype IN ('c', 'e', 'd')
       AND (t.typtype <> 'c' OR rc.relkind = 'c')
       ${typeFilter ? "AND t.typname LIKE $2" : ""}
     ORDER BY t.typname`

  const listParams = typeFilter ? [schema, typeFilter] : [schema]
  const listResult = await client.query(listSql, listParams)
  if (listResult.rows.length === 0) return []

  const out: PgObjectType[] = []
  for (const r of listResult.rows as Record<string, unknown>[]) {
    const typeName = r.type_name as string
    const typtype = r.typtype as string
    const typrelid = r.typrelid as number

    const obj: PgObjectType = { typeName, typtype }

    if (typtype === "e") {
      // 枚举：按 typname + schema 拉取枚举值（listSql 未选 oid，避免依赖）
      obj.enumLabels = await fetchEnumLabels(client, schema, typeName)
    } else if (typtype === "c") {
      // 复合类型：拉取字段
      obj.compositeFields = await fetchCompositeFields(client, typrelid)
    } else if (typtype === "d") {
      // 域类型
      obj.baseType = (r.base_type as string) || null
      obj.notNull = r.typnotnull as boolean
      obj.defaultExpr = (r.typdefault as string) ?? null
      obj.checkConstraints = await fetchDomainChecks(client, schema, typeName)
    }

    out.push(obj)
  }

  return out
}

/** 拉取枚举类型的枚举值（按 typname + schema 定位，避免依赖 listSql 的 oid） */
async function fetchEnumLabels(client: PgClient, schema: string, typeName: string): Promise<PgEnumValue[]> {
  const res = await client.query(
    `SELECT e.enumlabel
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 AND t.typname = $2
       ORDER BY e.enumsortorder`,
    [schema, typeName],
  )
  return res.rows.map((r: Record<string, unknown>) => ({ label: r.enumlabel as string }))
}

/** 拉取复合类型字段 */
async function fetchCompositeFields(client: PgClient, typrelid: number): Promise<PgCompositeField[]> {
  const res = await client.query(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS data_type
        FROM pg_attribute a
       WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
    [typrelid],
  )
  return res.rows.map((r: Record<string, unknown>) => ({
    attname: r.attname as string,
    dataType: r.data_type as string,
  }))
}

/** 拉取域类型的 CHECK 约束 */
async function fetchDomainChecks(client: PgClient, schema: string, typeName: string): Promise<string[]> {
  const res = await client.query(
    `SELECT pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c
        JOIN pg_type t ON t.oid = c.contypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = $1 AND t.typname = $2`,
    [schema, typeName],
  )
  return res.rows.map((r: Record<string, unknown>) => r.definition as string).filter(Boolean)
}

// ── DDL 生成 ──────────────────────────────────────────────────────────────

/** 统一小写转换（DDL 标识符统一为小写） */
function lc(s: string): string {
  return s.toLowerCase()
}

/** PostgreSQL 内置类型判断（基于 information_schema.data_type） */
const PG_BUILTIN_TYPES = new Set([
  "character varying", "character", "text", "smallint", "integer", "bigint",
  "numeric", "decimal", "real", "double precision", "boolean",
  "timestamp without time zone", "timestamp with time zone",
  "time without time zone", "time with time zone",
  "date", "bytea", "json", "jsonb", "uuid", "interval", "bit", "bit varying",
  "money", "oid", "inet", "cidr", "macaddr", "tsvector", "xml",
])

/**
 * 格式化列数据类型为 PG DDL 类型串。
 *
 * 优先用 information_schema.data_type 做内置类型映射；
 * 对 USER-DEFINED（枚举/复合）和 ARRAY 用 udt_name。
 */
function formatDataType(col: PgColumn): string {
  const dt = col.dataType.toLowerCase()

  // 数组：udt_name 形如 "_int4" / "_varchar"，元素类型去前导下划线后加 []
  if (dt === "array") {
    const elem = col.udtName.startsWith("_") ? col.udtName.slice(1) : col.udtName
    return `${mapUdtName(elem)}[]`
  }

  // 用户自定义类型（枚举/复合/域）：直接用 udt_name
  if (dt === "user-defined") {
    return col.udtName
  }

  if (!PG_BUILTIN_TYPES.has(dt)) {
    // 未知类型回退到 udt_name
    return col.udtName || col.dataType
  }

  switch (dt) {
    case "character varying":
      return col.charMaxLength != null ? `varchar(${col.charMaxLength})` : "varchar"
    case "character":
      return col.charMaxLength != null ? `char(${col.charMaxLength})` : "char"
    case "bit":
      return col.charMaxLength != null ? `bit(${col.charMaxLength})` : "bit"
    case "bit varying":
      return col.charMaxLength != null ? `bit varying(${col.charMaxLength})` : "bit varying"
    case "numeric":
    case "decimal": {
      if (col.numericPrecision != null && col.numericScale != null && col.numericScale > 0) {
        return `${dt}(${col.numericPrecision},${col.numericScale})`
      }
      if (col.numericPrecision != null) return `${dt}(${col.numericPrecision})`
      return dt
    }
    case "timestamp without time zone":
      return col.datetimePrecision != null ? `timestamp(${col.datetimePrecision})` : "timestamp"
    case "timestamp with time zone":
      return col.datetimePrecision != null
        ? `timestamptz(${col.datetimePrecision})`
        : "timestamptz"
    case "time without time zone":
      return col.datetimePrecision != null ? `time(${col.datetimePrecision})` : "time"
    case "time with time zone":
      return col.datetimePrecision != null ? `timetz(${col.datetimePrecision})` : "timetz"
    case "interval":
      return "interval"
    default:
      return dt
  }
}

/** udt_name（如 int4/int8/bool/timestamptz）→ 可读类型名映射 */
function mapUdtName(udt: string): string {
  const map: Record<string, string> = {
    int2: "smallint", int4: "integer", int8: "bigint",
    bool: "boolean", float4: "real", float8: "double precision",
    timestamp: "timestamp", timestamptz: "timestamptz",
    time: "time", timetz: "timetz", date: "date",
    numeric: "numeric", varchar: "varchar", bpchar: "char",
    text: "text", bytea: "bytea", json: "json", jsonb: "jsonb",
    uuid: "uuid", money: "money", bit: "bit", varbit: "bit varying",
  }
  return map[udt] ?? udt
}

/**
 * 规范化 default 值。
 * PG 的 column_default 已是可直接使用的表达式，仅 trim。
 */
function normalizeDefault(val: string | null): string | null {
  if (val == null) return null
  return val.trim() || null
}

/**
 * 转义 SQL 字符串中的单引号
 */
function escapeSingleQuotes(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * 生成单个表的 CREATE TABLE DDL（PG 语法）
 */
function generateTableDdl(
  tableName: string,
  columns: PgColumn[],
  constraints: PgConstraint[],
  tableComment: string | undefined,
  columnComments: Map<string, string>,
): string {
  const lines: string[] = []

  // 表注释（摘要行）
  if (tableComment) {
    lines.push(`-- ${tableComment}`)
  }

  lines.push(`create table ${lc(tableName)} (`)

  // 列定义
  const colDefs: string[] = []
  for (const col of columns) {
    const name = lc(col.columnName).padEnd(16)
    let def = `    ${name} ${formatDataType(col)}`

    // IDENTITY 列：GENERATED {ALWAYS|BY DEFAULT} AS IDENTITY（column_default 为 NULL）
    const idgen = col.identityGeneration
    if (idgen === "ALWAYS" || idgen === "BY DEFAULT") {
      def += ` generated ${idgen.toLowerCase()} as identity`
    } else {
      const dv = normalizeDefault(col.columnDefault)
      if (dv) {
        def += `   default ${dv}`
      }
    }

    def += col.nullable === "NO" ? " not null" : ""
    colDefs.push(def)
  }

  // 约束：按 p(PK) → u(UK) → f(FK) → c(CHECK) 排序，定义文本来自 pg_get_constraintdef
  const ordered = ["p", "u", "f", "c"]
  const sorted = [...constraints].sort(
    (a, b) => ordered.indexOf(a.contype) - ordered.indexOf(b.contype),
  )
  for (const c of sorted) {
    // pg_get_constraintdef 返回 "PRIMARY KEY (...)" 等，前置 CONSTRAINT name
    colDefs.push(`    constraint ${lc(c.conname)} ${c.definition}`)
  }

  lines.push(colDefs.join(",\n"))
  lines.push(");")
  lines.push("")

  // 表注释（PG 语法）
  if (tableComment) {
    lines.push(
      `comment on table ${lc(tableName)} is '${escapeSingleQuotes(tableComment)}';`,
    )
  }

  // 列注释
  if (columnComments.size > 0) {
    for (const [colName, comment] of columnComments) {
      lines.push(
        `comment on column ${lc(tableName)}.${lc(colName)} is '${escapeSingleQuotes(comment)}';`,
      )
    }
    lines.push("")
  }

  return lines.join("\n")
}

/**
 * 生成触发器 DDL（pg_get_triggerdef 原样输出）
 */
function generateTriggerDdl(trigger: PgTrigger): string {
  const def = trigger.definition.trimEnd()
  // pg_get_triggerdef 返回完整 CREATE TRIGGER 语句，补分号
  return `${def}${def.endsWith(";") ? "" : ";"}\n\n`
}

/**
 * 生成视图 DDL
 */
function generateViewDdl(view: PgView): string {
  const lines: string[] = []
  lines.push(`create or replace view ${lc(view.viewName)} as`)
  lines.push(view.definition.trimEnd())
  lines.push(";")
  lines.push("")
  return lines.join("\n")
}

/**
 * 生成所有序列 DDL（合并到一个文件）
 */
function generateSequencesDdl(sequences: PgSequence[]): string {
  const lines: string[] = ["-- 序列（从数据库自动获取）\n"]

  for (const seq of sequences) {
    let ddl = `create sequence ${lc(seq.sequenceName)}`
    if (seq.dataType) {
      // PG 允许 CREATE SEQUENCE ... AS smallint/integer/bigint
      const asType = seq.dataType.toLowerCase() === "smallint"
        ? "smallint"
        : seq.dataType.toLowerCase() === "bigint"
          ? "bigint"
          : "integer"
      ddl += ` as ${asType}`
    }
    if (seq.increment) ddl += ` increment by ${seq.increment}`
    if (seq.minValue) ddl += ` minvalue ${seq.minValue}`
    if (seq.maxValue) ddl += ` maxvalue ${seq.maxValue}`
    if (seq.startValue) ddl += ` start with ${seq.startValue}`
    if (seq.cacheSize != null) ddl += ` cache ${seq.cacheSize}`
    ddl += seq.cycleOption === "YES" ? " cycle" : " no cycle"
    ddl += ";"
    lines.push(ddl)
  }

  lines.push("")
  return lines.join("\n")
}

/**
 * 生成自定义类型 DDL（按 typtype 分支）
 */
function generateObjectTypeDdl(objType: PgObjectType): string {
  const lines: string[] = []
  const name = lc(objType.typeName)

  if (objType.typtype === "e" && objType.enumLabels) {
    const vals = objType.enumLabels.map(v => `'${escapeSingleQuotes(v.label)}'`).join(", ")
    lines.push(`create type ${name} as enum (${vals});`)
  } else if (objType.typtype === "c" && objType.compositeFields) {
    const fields = objType.compositeFields
      .map(f => `    ${lc(f.attname)} ${f.dataType}`)
      .join(",\n")
    lines.push(`create type ${name} as (\n${fields}\n);`)
  } else if (objType.typtype === "d") {
    let ddl = `create domain ${name} as ${objType.baseType || "unknown"}`
    if (objType.defaultExpr) ddl += ` default ${objType.defaultExpr}`
    if (objType.notNull) ddl += ` not null`
    if (objType.checkConstraints && objType.checkConstraints.length > 0) {
      for (const ck of objType.checkConstraints) {
        ddl += ` ${ck}`
      }
    }
    ddl += ";"
    lines.push(ddl)
  } else {
    // 兜底：基础声明
    lines.push(`create type ${name};`)
  }

  lines.push("")
  return lines.join("\n")
}

// ── 文件输出 ──────────────────────────────────────────────────────────────

/**
 * 生成不重复的文件路径。
 * 当小写化后文件名冲突时，追加数字后缀（orders.sql → orders_2.sql）避免覆盖。
 */
function dedupedFilePath(
  dir: string,
  baseName: string,      // 已小写化的文件名（不含扩展名）
  ext: string,           // 扩展名（含点，如 ".sql"）
  usedNames: Set<string>, // 已使用的文件名集合（不含目录前缀）
): string {
  let name = `${baseName}${ext}`
  if (!usedNames.has(name)) {
    usedNames.add(name)
    return join(dir, name)
  }
  let i = 2
  do {
    name = `${baseName}_${i}${ext}`
    i++
  } while (usedNames.has(name))
  usedNames.add(name)
  return join(dir, name)
}

/**
 * 将元数据生成 DDL 文件并写入 sourcePath 下
 */
function generateDdlFiles(
  sourcePath: string,
  data: {
    columns: PgColumn[]
    constraints: PgConstraint[]
    triggers: PgTrigger[]
    views: PgView[]
    sequences: PgSequence[]
    objectTypes: PgObjectType[]
    tableComments: PgTableComment[]
    columnComments: PgColumnComment[]
  },
): SchemaFetchResult {

  // 使用带时间戳的临时目录写入，完成后原子性 rename，避免崩溃时残留部分文件
  // 使用唯一后缀避免与前次残留目录冲突（如 rmSync 因文件锁定失败时）
  const stagingDir = join(sourcePath, `.schema-staging-${Date.now()}`)
  // 清理可能存在的上次 staging 目录（清理旧的 .schema-staging-* 目录）
  try {
    const entries = readdirSync(sourcePath, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith(".schema-staging") && entry.isDirectory()) {
        try { safeRm(join(sourcePath, entry.name)) } catch { /* best-effort 清理：safeRm 已内置重试，此处仅兜底 genuine 失败 */ }
      }
    }
  } catch { /* sourcePath 不存在或不可读 */ }

  const stagingSchemaDir = join(stagingDir, "schema")
  const stagingTriggerDir = join(stagingDir, "trigger")
  const stagingTypeDir = join(stagingDir, "type")
  mkdirSync(stagingSchemaDir, { recursive: true })
  mkdirSync(stagingTriggerDir, { recursive: true })
  mkdirSync(stagingTypeDir, { recursive: true })

  // 构建索引
  const columnsByTable = new Map<string, PgColumn[]>()
  for (const col of data.columns) {
    if (!columnsByTable.has(col.tableName)) columnsByTable.set(col.tableName, [])
    columnsByTable.get(col.tableName)!.push(col)
  }

  const constraintsByTable = new Map<string, PgConstraint[]>()
  for (const c of data.constraints) {
    if (!constraintsByTable.has(c.tableName)) constraintsByTable.set(c.tableName, [])
    constraintsByTable.get(c.tableName)!.push(c)
  }

  const tableCommentMap = new Map<string, string>()
  for (const tc of data.tableComments) {
    tableCommentMap.set(tc.tableName, tc.comments)
  }

  const colCommentMap = new Map<string, Map<string, string>>()
  for (const cc of data.columnComments) {
    if (!colCommentMap.has(cc.tableName)) colCommentMap.set(cc.tableName, new Map())
    colCommentMap.get(cc.tableName)!.set(cc.columnName, cc.comments)
  }

  // 生成表 DDL（每表一个文件）
  // 表和视图共享 stagingSchemaDir，用同一个 usedNames 防止同名覆盖
  const schemaUsedNames = new Set<string>()
  let tablesFetched = 0
  for (const [tableName, cols] of columnsByTable) {
    const constraints = constraintsByTable.get(tableName) || []
    const tc = tableCommentMap.get(tableName)
    const cc = colCommentMap.get(tableName) || new Map<string, string>()
    const ddl = generateTableDdl(tableName, cols, constraints, tc, cc)
    writeFileSync(dedupedFilePath(stagingSchemaDir, lc(tableName), ".sql", schemaUsedNames), ddl, "utf-8")
    tablesFetched++
  }

  // 生成触发器 DDL（每触发器一个文件）
  const triggerUsedNames = new Set<string>()
  let triggersFetched = 0
  for (const trigger of data.triggers) {
    const ddl = generateTriggerDdl(trigger)
    writeFileSync(dedupedFilePath(stagingTriggerDir, lc(trigger.triggerName), ".sql", triggerUsedNames), ddl, "utf-8")
    triggersFetched++
  }

  // 生成视图 DDL（每视图一个文件，放入 schema/ 目录）
  let viewsFetched = 0
  for (const view of data.views) {
    const ddl = generateViewDdl(view)
    writeFileSync(dedupedFilePath(stagingSchemaDir, lc(view.viewName), ".sql", schemaUsedNames), ddl, "utf-8")
    viewsFetched++
  }

  // 生成序列 DDL（合并一个文件）
  let sequencesFetched = 0
  if (data.sequences.length > 0) {
    const ddl = generateSequencesDdl(data.sequences)
    writeFileSync(join(stagingSchemaDir, "sequences.sql"), ddl, "utf-8")
    sequencesFetched = data.sequences.length
  }

  // 生成对象类型 DDL（每类型一个文件）
  const typeUsedNames = new Set<string>()
  let objectTypesFetched = 0
  for (const objType of data.objectTypes) {
    const ddl = generateObjectTypeDdl(objType)
    writeFileSync(dedupedFilePath(stagingTypeDir, lc(objType.typeName), ".sql", typeUsedNames), ddl, "utf-8")
    objectTypesFetched++
  }

  // 写入标记文件，标识此目录由 schema-fetcher 生成（供清理时区分用户自有目录）
  // 内容为 JSON，包含 generator 字段用于校验真实性
  const markerContent = JSON.stringify({
    generator: GENERATED_MARKER_ID,
    createdAt: new Date().toISOString(),
  })
  writeFileSync(join(stagingDir, GENERATED_MARKER), markerContent, "utf-8")

  // 提交 staging 目录为正式输出
  // 先删除旧输出目录，再 rename staging → outputDir
  // 不使用 backup/rollback 机制：DDL 可从数据库随时重新生成，
  // 且 rename-based rollback 在 Windows 上不可靠（EPERM on existing dir）
  const outputDir = join(sourcePath, GENERATED_OUTPUT_DIR)
  if (existsSync(outputDir)) {
    try {
      safeRm(outputDir)
    } catch (rmErr: any) {
      throw new Error(`无法清理旧的 ${GENERATED_OUTPUT_DIR} 目录: ${rmErr.message}`)
    }
  }

  try {
    atomicRename(stagingDir, outputDir)
  } catch (commitErr: any) {
    throw new Error(
      `DDL 文件提交失败（staging 目录仍保留: ${stagingDir}）: ${commitErr.message}`,
    )
  }

  return {
    tablesFetched,
    triggersFetched,
    viewsFetched,
    sequencesFetched,
    objectTypesFetched,
    outputDir: join(outputDir, "schema"),
  }
}

/**
 * 校验标记文件是否确实由 schema-fetcher 生成。
 * 通过读取并解析 JSON 内容中的 generator 字段判断，而非仅看文件是否存在。
 */
function isOurGeneratedMarker(markerPath: string): boolean {
  try {
    const raw = readFileSync(markerPath, "utf-8").trim()
    const parsed = JSON.parse(raw)
    return parsed.generator === GENERATED_MARKER_ID
  } catch {
    return false
  }
}

/**
 * 清理 schema-fetcher 生成的 ddl-output 目录。
 * 仅当目录内的标记文件由本工具生成时才清理，避免误删用户自建的同名目录。
 */
export function cleanupGeneratedDdl(sourcePath: string): void {
  const outputDir = join(sourcePath, GENERATED_OUTPUT_DIR)
  if (!existsSync(outputDir)) return
  const markerPath = join(outputDir, GENERATED_MARKER)
  if (!existsSync(markerPath) || !isOurGeneratedMarker(markerPath)) return
  try {
    safeRm(outputDir)
  } catch {
    // best-effort：清理失败不阻断主流程
  }
}

/**
 * 前置 schema 获取：连接 PG/GaussDB 拉取 schema 并生成 DDL 文件。
 *
 * 返回：
 * - { fetched: false }            无配置文件，DDL-only 模式（非错误）
 * - { fetched: true, result }     成功拉取并生成 DDL
 * - { fetched: false, error }     拉取失败
 */
export async function fetchSchemaIfNeeded(
  sourcePath: string,
  dbConfPath?: string,
): Promise<{ fetched: boolean; result?: SchemaFetchResult; error?: string }> {
  // 归一化：空字符串视为未指定
  const effectiveDbConfPath = (dbConfPath != null && dbConfPath !== "") ? dbConfPath : undefined

  // 0. sourcePath 必须存在（避免后续 mkdirSync 静默创建错误路径）
  if (!existsSync(sourcePath)) {
    return {
      fetched: false,
      error: `源码路径不存在: ${sourcePath}`,
    }
  }

  // 1. 加载配置（发现 db.properties → 拉取；无配置 → 静默跳过）
  let config: DbConfig
  try {
    const loaded = loadDbConfig(effectiveDbConfPath, sourcePath)
    if (!loaded) {
      // 无配置文件，DDL-only 模式，不是错误
      return { fetched: false }
    }
    config = loaded
  } catch (e: any) {
    return { fetched: false, error: e.message }
  }

  // 2. 动态加载 pg 驱动
  let pg: typeof import("pg")
  try {
    pg = await import("pg")
  } catch {
    return {
      fetched: false,
      error:
        "无法加载 pg 模块。请确认依赖已安装：\n" +
        "  cd .opencode && npm install",
    }
  }

  // 3. 连接数据库并拉取 schema
  const schema = config.schema
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any = null

  try {
    client = new pg.Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: resolvePassword(config.password),
      ssl: config.ssl,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
    })
    await client.connect()

    if (config.statementTimeoutMillis) {
      await client.query(`SET statement_timeout = ${config.statementTimeoutMillis}`)
    }

    getLogger().warn("[schema-fetcher]", `已连接 PostgreSQL/GaussDB，正在获取 schema: ${schema}`)

    // 顺序查询各类型元数据（单连接上避免并发查询）
    const tableFilter = config.tableFilter

    let columns: PgColumn[] = []
    let constraints: PgConstraint[] = []
    let triggers: PgTrigger[] = []
    let views: PgView[] = []
    let sequences: PgSequence[] = []
    let objectTypes: PgObjectType[] = []
    let tableComments: PgTableComment[] = []
    let columnComments: PgColumnComment[] = []

    // 表列 + 约束 + 注释（有表过滤时一起查）
    if (config.fetchTables) {
      columns = await fetchColumns(client, schema, tableFilter)
      constraints = await fetchConstraints(client, schema, tableFilter)
      const commentsResult = await fetchComments(client, schema, tableFilter)
      tableComments = commentsResult.tableComments
      columnComments = commentsResult.columnComments
    }

    if (config.fetchTriggers) {
      triggers = await fetchTriggers(client, schema, config.triggerFilter)
    }

    if (config.fetchViews) {
      views = await fetchViews(client, schema, config.viewFilter)
    }

    if (config.fetchSequences) {
      sequences = await fetchSequences(client, schema, config.sequenceFilter)
    }

    if (config.fetchObjectTypes) {
      objectTypes = await fetchObjectTypes(client, schema, config.typeFilter)
    }

    // 4. 检查是否有数据
    const totalCount = columns.length + triggers.length + views.length
      + sequences.length + objectTypes.length
    if (totalCount === 0) {
      getLogger().warn(
        "[schema-fetcher]",
        `schema "${schema}" 未找到任何对象（可能由过滤条件导致）。继续使用已有 PL/SQL 文件。`,
      )
      // 不阻断工作流：生成空的 ddl-output 目录，让 scanSource 继续处理本地文件
    }

    // 5. 生成 DDL 文件
    const result = generateDdlFiles(sourcePath, {
      columns,
      constraints,
      triggers,
      views,
      sequences,
      objectTypes,
      tableComments,
      columnComments,
    })

    getLogger().warn(
      "[schema-fetcher]",
      `DDL 文件已生成: ${result.tablesFetched} 表, ${result.triggersFetched} 触发器, ` +
      `${result.viewsFetched} 视图, ${result.sequencesFetched} 序列, ${result.objectTypesFetched} 类型`,
    )

    return { fetched: true, result }
  } catch (e: any) {
    // 识别常见 PG 错误
    const msg = e.message || String(e)
    const code = e.code as string | undefined

    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ETIMEDOUT") {
      return {
        fetched: false,
        error: `无法连接 PostgreSQL/GaussDB: ${msg}\n请检查 db.url 中的 host/port 和网络连通性。`,
      }
    }
    if (code === "28P01" || code === "28000") {
      return {
        fetched: false,
        error: `数据库认证失败。请检查 db.properties 中的 db.username/db.password。`,
      }
    }
    if (code === "3D000") {
      return {
        fetched: false,
        error: `数据库不存在: ${config.database}。请检查 db.url 中的数据库名。`,
      }
    }
    if (code === "42501") {
      return {
        fetched: false,
        error: `无权限访问系统目录。请确认用户对 schema "${schema}" 有读取权限。`,
      }
    }
    return { fetched: false, error: `Schema 获取失败: ${msg}` }
  } finally {
    if (client) {
      try { await client.end() } catch { /* ignore */ }
    }
  }
}
