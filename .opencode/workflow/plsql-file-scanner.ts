/**
 * PL/SQL 单文件 / 文件集 结构扫描（叶子模块）
 *
 * 从 plsql-scanner.ts 抽出的纯解析层：类型 + UpperCaseCharStream + 文本提取 + Listener
 * + parseFileAst。**仅依赖** node:fs / node:path / antlr4ts / ./plsql-ast/*，不拉 scanner
 * 的 scope-computer / workflow-logger / constants 等重链——故可被 worker 池安全 import
 * （打破 scanner→pool→worker→scanner 的循环 import）。
 *
 * parseFileAst / PlSqlStructListener 零语义变更（仍 mutate 调用方传入的 local Maps）。
 * scanFileSet 在一组文件上跑 listener（共享 local Map 正确处理同包 spec/body 跨文件合并），
 * 返回扁平 FileSetResult。**调用方须保证同一包的全部文件落在同一 file-set**（按包分区），
 * 这样跨 worker 无同 key 子程序，主线程拼接无需复现 spec↔body 槽位配对逻辑。
 */

import { readFileSync } from "node:fs"
import { PlSqlLexer } from "./plsql-ast/PlSqlLexer"
import { PlSqlParser } from "./plsql-ast/PlSqlParser"
import { PlSqlParserListener } from "./plsql-ast/PlSqlParserListener"
import type { Procedure_specContext, Function_specContext, Procedure_bodyContext, Function_bodyContext, Create_packageContext, Create_package_bodyContext, Create_function_bodyContext, Create_procedure_bodyContext, Variable_declarationContext, Exception_declarationContext, Type_declarationContext, Call_statementContext, Standard_functionContext, Routine_nameContext, ParameterContext } from "./plsql-ast/PlSqlParser"
import { CharStreams, CommonTokenStream, type Interval } from "antlr4ts"
import type { CharStream } from "antlr4ts/CharStream"
import { ParseTreeWalker } from "antlr4ts/tree/ParseTreeWalker"
import { ParserRuleContext } from "antlr4ts/ParserRuleContext"
import { TerminalNode } from "antlr4ts/tree/TerminalNode"
import { ErrorNode } from "antlr4ts/tree/ErrorNode"

// ── 类型 ────────────────────────────────────────────────────────────────────────

export interface ParamInfo {
  name: string
  type: string
  mode: "IN" | "OUT" | "IN OUT"
  defaultExpression: string | null
}

export interface LocationInfo {
  absolutePath: string
  lineRange: [number, number]
}

export interface DirectCall {
  package: string
  name: string
  line: number
  kind: "function" | "procedure"
}

/** 跨包非调用引用（pkg.const / pkg.type / pkg.var）——不进 callGraph，仅聚合进 packageDependency，
 *  使 scope-computer 闭包能纳入「仅常量/类型被引用」的包（修复 const-only 包漏入闭包）。 */
export interface PackageRef {
  package: string
  name: string
  line: number
}

export interface SubprogramInfo {
  name: string
  type: "PROCEDURE" | "FUNCTION"
  belongToPackage: string
  overloadIndex: number | null
  isPrivate: boolean
  headerLocation: LocationInfo | null
  bodyLocation: LocationInfo | null
  parameters: ParamInfo[]
  returnType: string | null
  loc: number
  directCalls: DirectCall[]
  packageRefs: PackageRef[]
}

export interface ConstantInfo { name: string; type: string; value: string }
export interface VariableInfo { name: string; type: string; defaultValue: string | null }
export interface ExceptionInfo { name: string }
export interface TypeInfo { name: string; kind: string; definition: string }

export interface PackageInfo {
  packageName: string
  absolutePaths: string[]
  headerPath: string | null
  bodyPath: string | null
  constants: ConstantInfo[]
  variables: VariableInfo[]
  exceptions: ExceptionInfo[]
  types: TypeInfo[]
  functions: string[]
  procedures: string[]
  estimatedLoc: number
}

export interface ColumnIndex {
  name: string
  oracleType: string
  nullable: boolean
  isPrimaryKey: boolean
  defaultValue?: string | null
}
export interface ForeignKeyInfo { name: string; columns: string[]; refTable: string; refColumns: string[] }

export interface TableIndex {
  name: string
  ddlFile?: string
  columns?: ColumnIndex[]
  primaryKey?: string[]
  foreignKeys?: ForeignKeyInfo[]
}

export interface TriggerIndex {
  name: string; sourceFile: string
  timing?: string; level?: string; targetTable?: string; events?: string[]
  lineRange?: [number, number]; condition?: string | null
}
export interface ViewIndex { name: string; ddlFile?: string; columns?: string[]; underlyingTables?: string[] }
export interface SequenceIndex {
  name: string; ddlFile?: string
  startWith?: number | null; incrementBy?: number | null
  minValue?: number | null; maxValue?: number | null; cycle?: boolean | null
}
export interface StandaloneProcIndex {
  name: string; type: "PROCEDURE" | "FUNCTION"; sourceFile: string
  parameters?: ParamInfo[]; returnType?: string | null; lineRange?: [number, number]
}

export interface InventoryIndex {
  sourcePath: string
  scannedAt: string
  scannerUsed: "ast" | "regex"
  warnings: string[]
  packages: PackageInfo[]
  subprograms: SubprogramInfo[]
  tables: TableIndex[]
  triggers: TriggerIndex[]
  views: ViewIndex[]
  sequences: SequenceIndex[]
  standaloneProcedures: StandaloneProcIndex[]
}

// ── 通用辅助 ────────────────────────────────────────────────────────────────────

/**
 * 大小写不敏感 CharStream 包装器。
 *
 * grammar 声明了 `caseInsensitive=true`，但 antlr4ts 4.7.2 不支持该选项（4.13+ 才有）——
 * 被忽略，生成的 lexer 大小写敏感（关键字 token 是大写 'CREATE' 等）。真实项目 PL/SQL 常用
 * 小写关键字（create/package/procedure），会解析失败。
 *
 * 解法：包装 CharStream，把 LA()（lookahead）返回的 a-z 转成 A-Z，让 lexer 按大写关键字匹配。
 * **只转 LA，不转 getText**——故字符串字面量 / 标识符 / 类型定义的原文大小写保留（通过
 * tokens.getText(sourceInterval) 取到原始文本），仅 token 匹配大小写不敏感。
 *
 * 注意：antlr4ts IntStream 的 `index` / `size` / `sourceName` 是 readonly **属性**（getter），
 * `consume`/`LA`/`mark`/`release`/`seek` 是方法——不能用方法形式实现 index/size，否则 lexer
 * 的 `this._input.index`（属性访问）取到方法函数，比较 `index < size` 变 NaN → 死循环。
 */
export class UpperCaseCharStream implements CharStream {
  constructor(private readonly src: CharStream) {}
  LA(i: number): number {
    const c = this.src.LA(i)
    // a-z (0x61-0x7A) → A-Z；EOF(-1) 与其他字符不变
    if (c >= 0x61 && c <= 0x7a) return c - 0x20
    return c
  }
  getText(interval: Interval): string { return this.src.getText(interval) }
  consume(): void { this.src.consume() }
  mark(): number { return this.src.mark() }
  release(marker: number): void { this.src.release(marker) }
  seek(index: number): void { this.src.seek(index) }
  get index(): number { return this.src.index }
  get size(): number { return this.src.size }
  get sourceName(): string { return this.src.sourceName }
}

/**
 * 全角语法符号归一化器（字符串/注释感知）。
 *
 * 仅对 SQL 代码区（字符串字面量、引号标识符、注释之外）的全角语法符号转半角；
 * 字符串内、引号标识符内、注释内的所有字符原样保留——下游 translate 经
 * tokens.getText 取到的字面量值字节级不变（含全角逗号、中文标点）。
 *
 * 根因：lexer 的 CHAR_STRING 只认 ASCII ' (U+0027) 作字符串边界。中文输入法常把
 * 边界打成全角 ‘ ’ (U+2018/2019)，lexer 不认 → 字符串未识别 → 串内全角标点暴露
 * 到语法层 → token recognition error → parse 失败。修法：恢复边界，串内内容继续
 * 被 CHAR_STRING 通配原样吞掉。
 *
 * 状态机覆盖：普通字符串(含 '' 转义)、q-quote(q'X...X')、双引号标识符(含 "" 转义)、
 * 行注释 --、块注释。引号等价类含全角形态。所有替换 1:1（全角与半角各占 1 个
 * UTF-16 code unit），归一化前后长度/offset/行号/列号完全对齐，下游基于 index 的
 * 计算（lineRangeOf / bodyLocation / locateSubprogramRange）不受影响。
 *
 * 已知限制：q-quote 的分隔符仅支持半角配对符 ()[]{}<> 与单字符；全角分隔符不识别
 * （此类文件本就极度不规范，罕见）。全角破折号 —— (U+2014) 作行注释起始不处理。
 */
const FULLWIDTH_SYNTAX: Record<string, string> = {
  "‘": "'", "’": "'",   // ‘ ’
  "“": '"', "”": '"',   // “ ”
  "；": ";",                   // ；
  "（": "(", "）": ")",   // （ ）
  "：": ":",                   // ：
  "＝": "=",                   // ＝
  "，": ",",                   // ，
  "．": ".",                   // ．
  "＋": "+", "－": "-",    // ＋ －
  "＊": "*", "／": "/",    // ＊ ／
  "％": "%",                   // ％
  "＜": "<", "＞": ">",    // ＜ ＞
  "！": "!",                   // ！
  "＆": "&", "｜": "|",   // ＆ ｜
}
const normSyntax = (c: string): string => FULLWIDTH_SYNTAX[c] ?? c
const isSQuote = (c: string): boolean => c === "'" || c === "‘" || c === "’"
const isDQuote = (c: string): boolean => c === '"' || c === "“" || c === "”"
const QQUOTE_PAIR: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" }

export function normalizeFullwidthSyntax(code: string): string {
  const n = code.length
  let out = ""
  let i = 0
  let state: "CODE" | "STR" | "QQU" | "DID" | "LINE" | "BLK" = "CODE"
  let qClose: string | null = null

  while (i < n) {
    const c = code[i]
    switch (state) {
      case "CODE": {
        const nc = normSyntax(c)
        const nc2 = i + 1 < n ? normSyntax(code[i + 1]) : ""
        if (nc === "-" && nc2 === "-") { out += "--"; i += 2; state = "LINE"; continue }
        if (nc === "/" && nc2 === "*") { out += "/*"; i += 2; state = "BLK"; continue }
        if (isSQuote(c)) { out += "'"; i += 1; state = "STR"; continue }
        if (isDQuote(c)) { out += '"'; i += 1; state = "DID"; continue }
        // q-quote: q/Q 紧跟单引号类
        if ((c === "q" || c === "Q") && i + 1 < n && isSQuote(code[i + 1])) {
          out += "q'"; i += 2
          if (i >= n) break
          const d = code[i]
          out += d; i += 1
          qClose = QQUOTE_PAIR[d] ?? d
          state = "QQU"; continue
        }
        out += nc; i += 1; continue
      }
      case "STR": {
        if (isSQuote(c)) {
          // '' 转义（含全角连续）→ 输出 '' 吞两个，留在 STR
          if (i + 1 < n && isSQuote(code[i + 1])) { out += "''"; i += 2; continue }
          out += "'"; i += 1; state = "CODE"; continue
        }
        out += c; i += 1; continue
      }
      case "DID": {
        if (isDQuote(c)) {
          if (i + 1 < n && isDQuote(code[i + 1])) { out += '""'; i += 2; continue }
          out += '"'; i += 1; state = "CODE"; continue
        }
        out += c; i += 1; continue
      }
      case "QQU": {
        // q-quote 内原样保留；结束分隔符 + 单引号类 → 结束
        if (c === qClose && i + 1 < n && isSQuote(code[i + 1])) {
          out += c; out += "'"; i += 2; state = "CODE"; qClose = null; continue
        }
        out += c; i += 1; continue
      }
      case "LINE": {
        if (c === "\n") { out += c; i += 1; state = "CODE"; continue }
        out += c; i += 1; continue
      }
      case "BLK": {
        if (c === "*" && i + 1 < n && code[i + 1] === "/") { out += "*/"; i += 2; state = "CODE"; continue }
        out += c; i += 1; continue
      }
    }
  }
  return out
}

/** 规范化标识符：去引号、去空白、大写、保留点（包名 fm.xxx 的点编码子目录路径） */
export function cleanName(name: string): string {
  return name.replace(/["`]/g, "").trim().toUpperCase()
}

/**
 * 按 Oracle 名字解析语义把限定名拆为 {pkg, member}，锚定到 caller 所属 schema：
 *   1 段 proc             → pkg = callerPkg（同包裸名）
 *   2 段 pkg.proc         → pkg = callerSchema.pkg（补当前 schema；caller 无 schema 则原样）
 *   3+ 段 schema.pkg.proc → pkg = schema.pkg（完整路径精确）
 * 归一化后 pkg 恰为声明键形式（如 FMBM.P_FM_LOG / MFG_ERP.F_EXC），下游 packageFileMap /
 * subprogramIndex / refIndex 精确匹配即可，无需各自做 schema 归一化。callerSchema = callerPkg
 * 去掉最后一段（声明键最后一段是包名，前缀是 schema）。
 *
 * 单一真相源：listener 的 recordCall/recordPackageRef 与 regex 兜底 extractCallsByRegex 共用，
 * 保证 AST 路径与正则兜底的三段归一化语义一致。
 */
export function resolveQualifiedName(qualified: string, callerPkg: string): { pkg: string; member: string } {
  const segs = qualified.replace(/["`]/g, "").split(".").map(s => s.trim()).filter(Boolean)
  if (segs.length === 0) return { pkg: callerPkg, member: "" }
  const member = cleanName(segs[segs.length - 1])
  let pkg: string
  if (segs.length === 1) {
    pkg = callerPkg
  } else if (segs.length === 2) {
    const lastDot = callerPkg.lastIndexOf(".")
    const callerSchema = lastDot > 0 ? callerPkg.slice(0, lastDot) : ""
    const pkgPart = cleanName(segs[0])
    pkg = callerSchema ? `${callerSchema}.${pkgPart}` : pkgPart
  } else {
    pkg = cleanName(segs.slice(0, -1).join("."))
  }
  return { pkg, member }
}

/** 从源码文本提取声明的包名（大写、保留点）。
 *  先剥块注释（slash-star ... star-slash）——Oracle 12c+ 导出 PACKAGE BODY 时在
 *  `CREATE OR REPLACE` 与 `PACKAGE` 间插 EDITIONABLE 内联注释，裸正则不匹配 → 包被当无包文件
 *  → partition/Phase0 把 spec 与 body 分到不同 file-set → 跨文件 spec↔body 合并断裂。
 *  antlr grammar 本就容忍该注释，此处对齐 grammar 行为。供 partitionFilesByPackage 与
 *  scanSourceLazy Phase 0 共用。
 *
 *  **包名规范化须与 grammar 的 extractFullPackageName 完全一致**（SCHEMA.LOCAL，引号去之），
 *  否则 spec 与 body 抽出不同名 → 落不同 packageFileMap 桶 → body 桶永不被 BFS 入队 → body
 *  文件从不解析 → 全部 bodyLocation=null + body 内 directCalls 丢失（间接调用闭包不展开）。
 *  旧正则 `([A-Za-z_][\w.]*)` 在引号标识符处截断：DBMS_METADATA 默认导出 `"SCHEMA"."PKG"`
 *  形态，spec 抽出 `SCHEMA`、body 抽出 `BODY`（误吃关键字），完全错位 → 系统性 body 丢失。
 *  改为按「引号段 | 裸标识符」逐段匹配 + cleanName 重组，与 grammar 同构。 */
export function extractPackageNames(code: string): string[] {
  // 剥块注释 + 行注释：CREATE 语句里的 -- 行注释会让正则失配 → body 抽不到包名 → body 与 spec
  // 被分到不同 file-set → 不共享 Map → 产出 header-only / body-only 两个分裂槽位 → header 槽位
  // bodyLocation=null（且被误判为重载）。容忍 EDITIONABLE/NONEDITIONABLE literal 关键字
  //（Oracle 12c+ DBMS_METADATA 导出 PACKAGE 常见，非 /*EDITIONABLE*/ 注释形式）。
  const clean = code.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ")
  // 段 = 引号串 "..." 或裸标识符；qualified = 段（可选 .段 重复）。后随空白/;/词界 IS/AS，
  // 避免吞掉 PACKAGE BODY 后紧跟的 AS/IS 修饰。引号段与裸段都经 cleanName 去引号+大写+保留点。
  const seg = `(?:"[A-Za-z_][\\w]*"|[A-Za-z_][\\w]*)`
  const re = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:(?:EDITIONABLE|NONEDITIONABLE)\\s+)?PACKAGE\\s+(BODY\\s+)?(${seg}(?:\\s*\\.\\s*${seg})*)(?=\\s|;|$|\\bIS\\b|\\bAS\\b)`,
    "gi",
  )
  const names: string[] = []
  for (const m of clean.matchAll(re)) {
    const n = cleanName(m[2])
    if (n && !names.includes(n)) names.push(n)
  }
  return names
}

/** 规范化类型文本：'VARCHAR2 ( 50 )' → 'VARCHAR2(50)'，'t_item %ROWTYPE' → 't_item%ROWTYPE' */
export function normalizeTypeText(s: string): string {
  return s.replace(/\s*([(),%])\s*/g, "$1").replace(/\s+/g, " ").trim()
}

/** 取 ctx 的起止行号（1-based 闭区间）；stop 缺失时退化为 start */
export function ctxLineRange(ctx: ParserRuleContext): [number, number] | null {
  const s = ctx.start?.line
  const e = ctx.stop?.line ?? s
  if (!s) return null
  return [s, e]
}

/** 取 ctx 原始文本（保留大小写，供类型/默认值等） */
export function ctxText(ctx: ParserRuleContext | undefined | null): string {
  if (!ctx) return ""
  return ctx.text ?? ""
}

// ── SQL*Plus 命令预处理 ────────────────────────────────────────────────────────

/**
 * 剥离 SQL*Plus 专有命令，避免解析器报错。
 * SQL*Plus 命令是客户端编排指令（prompt/@@/SET ECHO 等），只出现在 PL/SQL 单元之外的顶层
 * （install.sql / schema 脚本里）。**单元内不剥**——`SET col = val`（UPDATE SET）、`EXIT WHEN`
 * 是 PL/SQL，旧实现按行首关键字 `^SET\b`/`^EXIT\b` 误剥，导致 UPDATE 丢 SET 行 → 语法错误
 * → 错误恢复级联 → 漏捕获跨包引用。
 *
 * 单元边界：`CREATE [OR REPLACE] (PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE)` 起，独占一行的 `/`
 * （SQL*Plus 终止符）止。资源里单元均以 `/` 结尾。
 */
export function stripSqlPlusCommands(code: string): string {
  // 仅剥离 grammar 不认的纯顶层 SQL*Plus 命令。grammar 认的（PROMPT/REM/@@/@/SET/EXIT/QUIT/
  // SHOW/TIMING/CLEAR）交给 antlr4 的 sql_plus_command 规则——由语法上下文区分 SQL*Plus 的 SET 与
  // PL/SQL 的 UPDATE SET、SQL*Plus 的 EXIT 与 PL/SQL 的 EXIT WHEN，无需 unitStart/unitEnd 单元边界
  // 判断。旧版用边界正则模拟这个区分，因不容忍 /*EDITIONABLE*/ 等内联注释而 inUnit 全程 false，
  // 误把单元内 EXIT WHEN / UPDATE SET 当 SQL*Plus 命令剥掉 → 语法断裂 → 后续子程序 bodyLocation=null。
  // 此处所列命令（SPOOL/DEFINE/...）从不出现在 PL/SQL 单元内，只按行首关键字 + 括号外判断即可。
  // 括号内不剥：CREATE TABLE 列定义里可能恰好是这些词作列名（括号深度跨行累积）。
  const sqlPlusLine = /^(SPOOL|DEFINE|UNDEFINE|VARIABLE|ACCEPT|WHENEVER|HOST|COLUMN|TTITLE|BTITLE|BREAK|COMPUTE)\b/i
  // GRANT 权限语句：顶层 DDL、可能跨行（到分号止）。grammar 虽有 GRANT token 但不全认
  // `GRANT EXECUTE ON PACKAGE schema.obj TO role` 形式（报 missing 'TO'），且权限语句对
  // 包/过程/表分析无信息贡献 → 剥掉。行首 GRANT 起，到含 `;` 的行止；跨行续行用 inGrant 状态剥。
  // 不检查 parenDepth：GRANT 是顶层 DDL，绝不会出现在 CREATE TABLE 列定义括号内（不像 SPOOL 可能
  // 作列名）；PL/SQL 块内的 GRANT 须经 EXECUTE IMMEDIATE 'GRANT...'（行首非 GRANT，不误剥）。
  // 行注释 `-- GRANT`/块注释内的 GRANT 行首非 GRANT，不匹配。
  const grantLine = /^\s*GRANT\b/i
  let parenDepth = 0
  let inGrant = false
  return code
    .split("\n")
    .map(line => {
      const trimmed = line.trimStart()
      if (inGrant) {
        parenDepth += parenDelta(line)
        if (line.includes(";")) inGrant = false
        return ""
      }
      if (grantLine.test(trimmed)) {
        parenDepth += parenDelta(line)
        if (!line.includes(";")) inGrant = true
        return ""
      }
      if (parenDepth === 0 && sqlPlusLine.test(trimmed)) {
        parenDepth += parenDelta(line)
        return ""
      }
      parenDepth += parenDelta(line)
      return line
    })
    .join("\n")
}

/** 单行括号深度增量（跳过单引号字符串内的括号，'' 视为转义引号） */
export function parenDelta(line: string): number {
  let depth = 0
  let inStr = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") {
      if (inStr && line[i + 1] === "'") { i++; continue }  // 转义引号 ''
      inStr = !inStr
    } else if (!inStr) {
      if (c === "(") depth++
      else if (c === ")") depth--
    }
  }
  return depth
}

// ── AST Listener ─────────────────────────────────────────────────────────────────

/** SQL 伪列 / 内建函数，不计入 directCalls（后过滤会再按已知子程序收窄，此处快速排除常见 SQL 函数） */
export const SQL_PSEUDO = new Set([
  "NEXTVAL", "CURRVAL", "COUNT", "EXISTS", "FIRST", "LAST",
  "ROWNUM", "ROWID", "LEVEL", "ROWTYPE", "TYPE",
  "ROWCOUNT", "FOUND", "NOTFOUND", "ISOPEN", "BULK_ROWCOUNT",
  "SUM", "AVG", "MIN", "MAX", "ROUND", "LEAST", "GREATEST",
  "SYSDATE", "SYSTIMESTAMP", "USER", "UID",
  "NVL", "NVL2", "COALESCE", "NULLIF", "DECODE", "CASE",
  "TO_CHAR", "TO_NUMBER", "TO_DATE", "TO_TIMESTAMP", "TO_CLOB",
  "SUBSTR", "INSTR", "LENGTH", "LENGTHB", "TRIM", "LTRIM", "RTRIM",
  "UPPER", "LOWER", "INITCAP", "REPLACE", "TRANSLATE", "LPAD", "RPAD",
  "MOD", "ABS", "POWER", "CEIL", "FLOOR", "SIGN", "TRUNC",
  "ADD_MONTHS", "MONTHS_BETWEEN", "LAST_DAY", "EXTRACT",
  "DBMS_OUTPUT", "SQLERRM", "SQLCODE",
])

/**
 * 单文件 Listener：把 PL/SQL 结构抽取到全局累加器（packages/subprograms）。
 * 跨文件 header/body 合并：subprograms 按 `PKG.METHOD` 键 + 重载顺序槽位合并 headerLocation/bodyLocation。
 */
export class PlSqlStructListener implements PlSqlParserListener {
  /** 当前所处包名（大写带点）；spec/body 进入时置位，退出时清空 */
  private currentPackage: string | null = null
  /** 当前所处子程序栈（仅 body 压栈，用于 directCalls 归属 caller） */
  private subprogramStack: SubprogramInfo[] = []
  /** 嵌套局部过程（过程体内 declare_spec 递归定义）的槽位标记：不注册为包级，
   *  exit 时把其 directCalls/packageRefs 卷回外层后弹出，避免污染 subprograms/重载/callGraph。 */
  private readonly localSlots = new WeakSet<SubprogramInfo>()
  /** 包级声明栈深度：仅在栈空时收 package 级 constants/variables/types/exceptions */
  constructor(
    private readonly absolutePath: string,
    private readonly packages: Map<string, PackageInfo>,
    private readonly subprograms: Map<string, SubprogramInfo[]>,
    private readonly standaloneProcedures: StandaloneProcIndex[],
    private readonly standaloneSlots: SubprogramInfo[],
    private readonly warnings: string[],
    private readonly tokens: CommonTokenStream,
  ) {}

  /** 取 ctx 的原始文本（含空格）—— `ctx.text` 递归拼接子节点去空格，无法识别
   *  `IS RECORD`/`IS TABLE OF` 等多词关键字，故用 token stream 按 sourceInterval 取原文。 */
  private origText(ctx: ParserRuleContext | null | undefined): string {
    if (!ctx) return ""
    try {
      return this.tokens.getText(ctx.sourceInterval)
    } catch {
      return ctxText(ctx)
    }
  }

  // ── 包级 ────────────────────────────────────────────────────────────────────

  private getOrCreatePackage(fullName: string): PackageInfo {
    const name = cleanName(fullName)
    this.currentPackage = name
    let pkg = this.packages.get(name)
    if (!pkg) {
      pkg = {
        packageName: name,
        absolutePaths: [],
        headerPath: null,
        bodyPath: null,
        constants: [],
        variables: [],
        exceptions: [],
        types: [],
        functions: [],
        procedures: [],
        estimatedLoc: 0,
      }
      this.packages.set(name, pkg)
    }
    if (!pkg.absolutePaths.includes(this.absolutePath)) pkg.absolutePaths.push(this.absolutePath)
    return pkg
  }

  /** 从 create_package/body ctx 提取完整包名（schema.package，保留点） */
  private extractFullPackageName(ctx: Create_packageContext | Create_package_bodyContext): string | null {
    // package_name 在规则里被引用两次（PACKAGE 后 + END 后），antlr4ts 返回数组；取首个。
    const pns = ctx.package_name() as unknown
    const pnArr = Array.isArray(pns) ? pns : [pns]
    const name = pnArr[0]?.text
    if (!name) return null
    const schema = ctx.schema_object_name()?.text
    return schema ? `${schema}.${name}` : name
  }

  enterCreate_package(ctx: Create_packageContext) {
    const full = this.extractFullPackageName(ctx)
    if (!full) return
    const pkg = this.getOrCreatePackage(full)
    if (!pkg.headerPath) pkg.headerPath = this.absolutePath
    // 用原始含换行文本计 LOC（ctx.text 去空格无换行，恒 1 行/ctx）
    pkg.estimatedLoc += this.origText(ctx).split("\n").length
  }
  enterCreate_package_body(ctx: Create_package_bodyContext) {
    const full = this.extractFullPackageName(ctx)
    if (!full) return
    const pkg = this.getOrCreatePackage(full)
    if (!pkg.bodyPath) pkg.bodyPath = this.absolutePath
    pkg.estimatedLoc += this.origText(ctx).split("\n").length
  }
  exitCreate_package() { this.currentPackage = null }
  exitCreate_package_body() { this.currentPackage = null }

  // ── 子程序注册（spec=headerLocation, body=bodyLocation + 压栈）──────────────

  /**
   * 注册子程序：按 `PKG.METHOD` 键取槽位数组。
   *  - spec：找首个 headerLocation===null 的槽位填 headerLocation；无则新建槽位。
   *  - body：找首个 bodyLocation===null 的槽位填 bodyLocation；无则新建槽位（私有方法）。
   * 参数/返回类型：spec 优先（权威签名），body 仅在槽位无参数时补（私有方法）。
   */
  private registerSubprogram(
    nameRaw: string,
    type: "PROCEDURE" | "FUNCTION",
    isBody: boolean,
    ctx: Procedure_specContext | Function_specContext | Procedure_bodyContext | Function_bodyContext,
    params: ParamInfo[],
    returnType: string | null,
  ): SubprogramInfo | null {
    if (!this.currentPackage) return null
    const name = cleanName(nameRaw)
    const key = `${this.currentPackage}.${name}`
    const slots = this.subprograms.get(key) ?? []

    let slot: SubprogramInfo | undefined
    if (isBody) {
      slot = slots.find(s => s.bodyLocation === null)
    } else {
      slot = slots.find(s => s.headerLocation === null)
    }
    if (!slot) {
      slot = {
        name,
        type,
        belongToPackage: this.currentPackage,
        overloadIndex: null,            // 最终扁平化时按槽位数组长度决定
        isPrivate: false,
        headerLocation: null,
        bodyLocation: null,
        parameters: [],
        returnType: null,
        loc: 0,
        directCalls: [],
        packageRefs: [],
      }
      slots.push(slot)
      this.subprograms.set(key, slots)
    }
    const range = ctxLineRange(ctx)
    const loc: LocationInfo | null = range ? { absolutePath: this.absolutePath, lineRange: range } : null
    if (isBody) {
      if (loc) { slot.bodyLocation = loc; slot.loc = loc.lineRange[1] - loc.lineRange[0] + 1 }
      if (slot.parameters.length === 0 && params.length > 0) slot.parameters = params
      if (slot.returnType === null && returnType !== null) slot.returnType = returnType
      this.subprogramStack.push(slot)
    } else {
      if (loc) slot.headerLocation = loc
      // spec 是签名权威：覆盖参数/返回类型
      if (params.length > 0) slot.parameters = params
      if (type === "FUNCTION") slot.returnType = returnType
    }
    slot.isPrivate = slot.headerLocation === null
    return slot
  }

  enterProcedure_spec(ctx: Procedure_specContext) {
    const name = ctx.identifier()?.text
    if (!name) return
    this.registerSubprogram(name, "PROCEDURE", false, ctx, extractParams(ctx.parameter()), null)
  }
  enterFunction_spec(ctx: Function_specContext) {
    const name = ctx.identifier()?.text
    if (!name) return
    this.registerSubprogram(name, "FUNCTION", false, ctx, extractParams(ctx.parameter()), extractReturnType(ctx))
  }
  enterProcedure_body(ctx: Procedure_bodyContext) {
    const name = ctx.identifier()?.text
    if (!name) return
    this.enterSubprogramBody(name, "PROCEDURE", ctx, extractParams(ctx.parameter()), null)
  }
  enterFunction_body(ctx: Function_bodyContext) {
    const name = ctx.identifier()?.text
    if (!name) return
    this.enterSubprogramBody(name, "FUNCTION", ctx, extractParams(ctx.parameter()), extractReturnType(ctx))
  }
  exitProcedure_body() { this.popSubprogramBody() }
  exitFunction_body() { this.popSubprogramBody() }

  /**
   * 进入子程序体。栈空 = 顶层包体子程序（与 spec 配对，注册为包级）；
   * 栈非空 = 嵌套局部过程（declare_spec 递归触发）——不注册（否则污染 subprograms/重载/callGraph），
   * 仅压局部槽位使体内调用归属正确，exit 时卷回外层。
   */
  private enterSubprogramBody(
    nameRaw: string, type: "PROCEDURE" | "FUNCTION",
    ctx: Procedure_bodyContext | Function_bodyContext,
    params: ParamInfo[], returnType: string | null,
  ): void {
    if (!this.currentPackage) return
    if (this.subprogramStack.length === 0) {
      this.registerSubprogram(nameRaw, type, true, ctx, params, returnType)
      return
    }
    const name = cleanName(nameRaw)
    const range = ctxLineRange(ctx)
    const slot: SubprogramInfo = {
      name, type,
      belongToPackage: this.currentPackage,
      overloadIndex: null,
      isPrivate: true,
      headerLocation: null,
      bodyLocation: range ? { absolutePath: this.absolutePath, lineRange: range } : null,
      parameters: params, returnType,
      loc: range ? range[1] - range[0] + 1 : 0,
      directCalls: [], packageRefs: [],
    }
    this.subprogramStack.push(slot)
    this.localSlots.add(slot)
  }

  /** 退出子程序体：局部槽位的调用卷回外层后弹出；包级槽位直接弹出。 */
  private popSubprogramBody(): void {
    const slot = this.subprogramStack.pop()
    if (slot && this.localSlots.has(slot)) {
      const outer = this.subprogramStack[this.subprogramStack.length - 1]
      if (outer) {
        outer.directCalls.push(...slot.directCalls)
        outer.packageRefs.push(...slot.packageRefs)
      }
      this.localSlots.delete(slot)
    }
  }

  // ── standalone CREATE PROCEDURE/FUNCTION（顶层，非包内）──────────────────────
  //   建子程序槽位并压 subprogramStack，使体内的 directCalls/packageRefs 被捕获（旧实现仅推
  //   standaloneProcedures 索引、不压栈，导致 enterCall_statement 等因栈空早退，standalone 体内调用全丢，
  //   injectStandaloneVirtualPackages 写死 directCalls:[]）。槽位与索引同序推入 standaloneSlots，
  //   由 injectStandaloneVirtualPackages 配对挂到虚拟包。
  enterCreate_function_body(ctx: Create_function_bodyContext) {
    const name = cleanName(ctx.function_name()?.text ?? "")
    if (!name) return
    const range = ctxLineRange(ctx)
    this.standaloneProcedures.push({
      name, type: "FUNCTION", sourceFile: this.absolutePath,
      parameters: extractParams(ctx.parameter()),
      returnType: normalizeTypeText(ctxText(ctx.type_spec())) || null,
      lineRange: range ?? undefined,
    })
    this.pushStandaloneSlot(name, "FUNCTION", range)
  }
  enterCreate_procedure_body(ctx: Create_procedure_bodyContext) {
    const name = cleanName(ctx.procedure_name()?.text ?? "")
    if (!name) return
    const range = ctxLineRange(ctx)
    this.standaloneProcedures.push({
      name, type: "PROCEDURE", sourceFile: this.absolutePath,
      parameters: extractParams(ctx.parameter()),
      returnType: null,
      lineRange: range ?? undefined,
    })
    this.pushStandaloneSlot(name, "PROCEDURE", range)
  }
  exitCreate_function_body() { this.subprogramStack.pop() }
  exitCreate_procedure_body() { this.subprogramStack.pop() }

  /** 建 standalone 槽位并压栈（belongToPackage 占位，由 injectStandaloneVirtualPackages 回填虚拟包名） */
  private pushStandaloneSlot(name: string, type: "PROCEDURE" | "FUNCTION", range: [number, number] | null) {
    const slot: SubprogramInfo = {
      name, type,
      belongToPackage: "",  // 占位，injectStandaloneVirtualPackages 回填 __STANDALONE_x__
      overloadIndex: null,
      isPrivate: false,
      headerLocation: null,
      bodyLocation: range ? { absolutePath: this.absolutePath, lineRange: range } : null,
      parameters: [],
      returnType: null,
      loc: range ? range[1] - range[0] + 1 : 0,
      directCalls: [],
      packageRefs: [],
    }
    this.subprogramStack.push(slot)
    this.standaloneSlots.push(slot)
  }

  // ── 包级声明（仅在 subprogramStack 为空时收，避免收进过程局部变量）─────────

  enterVariable_declaration(ctx: Variable_declarationContext) {
    if (!this.currentPackage || this.subprogramStack.length > 0) return
    const pkg = this.packages.get(this.currentPackage)!
    const name = cleanName(ctx.identifier()?.text ?? "")
    if (!name) return
    const isConst = !!ctx.CONSTANT()
    const type = normalizeTypeText(ctxText(ctx.type_spec())) || "unknown"
    const defaultExpr = ctx.default_value_part()?.expression()
    const valueText = defaultExpr ? normalizeTypeText(ctxText(defaultExpr)) : null
    if (isConst) {
      pkg.constants.push({ name, type, value: valueText ?? "" })
    } else {
      pkg.variables.push({ name, type, defaultValue: valueText })
    }
  }

  enterException_declaration(ctx: Exception_declarationContext) {
    if (!this.currentPackage || this.subprogramStack.length > 0) return
    const pkg = this.packages.get(this.currentPackage)!
    const name = cleanName(ctx.identifier()?.text ?? "")
    if (name) pkg.exceptions.push({ name })
  }

  enterType_declaration(ctx: Type_declarationContext) {
    if (!this.currentPackage || this.subprogramStack.length > 0) return
    const pkg = this.packages.get(this.currentPackage)!
    const name = cleanName(ctx.identifier()?.text ?? "")
    if (!name) return
    // 用原始含空格文本识别 kind（ctx.text 去空格会让 "IS RECORD" 变 "ISRECORD" 漏匹配）
    const def = this.origText(ctx)
    let kind = "UNKNOWN"
    if (/IS\s+RECORD/i.test(def)) kind = "RECORD"
    else if (/IS\s+TABLE\s+OF/i.test(def)) kind = "TABLE"
    else if (/IS\s+VARRAY/i.test(def) || /VARRAY/i.test(def)) kind = "VARRAY"
    else if (/IS\s+REF\s+CURSOR/i.test(def) || /REF\s+CURSOR/i.test(def)) kind = "REF CURSOR"
    pkg.types.push({ name, kind, definition: normalizeTypeText(def) })
  }

  // ── directCalls（caller 栈非空时记）────────────────────────────────────────

  enterCall_statement(ctx: Call_statementContext) {
    if (this.subprogramStack.length === 0) return
    // call_statement: CALL? routine_name function_argument? ('.' routine_name function_argument?)* ...
    // routine_name 被引用多次，antlr4ts 返回数组；join 所有 routine_name 文本得完整限定名。
    const rns = ctx.routine_name() as unknown
    const rnArr = Array.isArray(rns) ? rns : [rns]
    const parts = rnArr.map(rn => rn?.text).filter(Boolean)
    if (parts.length === 0) return
    this.recordCall(parts.join("."), ctx.start.line, "procedure")
  }
  enterStandard_function(ctx: Standard_functionContext) {
    if (this.subprogramStack.length === 0) return
    // standard_function 文本形如 'pkg.func(args)' 或 'func(args)'；正则取前置限定名
    const m = ctxText(ctx).match(/^([A-Za-z_][\w.]*)\s*\(/)
    if (!m) return
    this.recordCall(m[1], ctx.start.line, "function")
  }

  // 用户函数调用（如 `v := get_item(p)` / `pkg.func(p)`）在 PL/SQL 表达式中走 general_element
  //（非 standard_function），standard_function 只覆盖 SQL 内建函数。监听 general_element 的 part，
  // 带 function_argument 的 part 即调用点：限定名 = 前置 part.id + 本 part.id。
  enterGeneral_element(ctx: any) {
    if (this.subprogramStack.length === 0) return
    const text = ctxText(ctx)
    // general_element 是递归规则（general_element ('.' general_element_part)+），
    // ctx.general_element_part() 只返回最末段，dotted 限定符在嵌套子节点——故用整体文本解析。
    // 拆分与 schema 归一化统一走 resolveQualified（与 recordCall/recordPackageRef 单一真相源），
    // 按 Oracle 名字解析语义按段数锚定到 caller schema，正确处理 dotted 包名与 schema 限定。
    const parenIdx = text.indexOf("(")
    if (parenIdx < 0) {
      // 非调用限定引用：pkg.const / pkg.type / pkg.var（表达式中的常量/类型/变量引用）。
      const cleaned = text.replace(/["`]/g, "")
      if (!cleaned.includes(".")) return  // 裸名变量引用，无包限定符
      this.recordPackageRef(cleaned, ctx.start.line)
      return
    }
    // 调用：限定名 = '(' 之前文本（含 pkg.func 形式）。直接传完整限定名给 recordCall（其内部走
    // resolveQualified 按段数拆 pkg/member、处理裸名归属 + SQL_PSEUDO + 自递归）。修复递归 grammar
    // 导致 ctx.general_element_part() 只取末段、限定调用 pkg.func(args) 丢前缀被记成裸名遭后过滤丢弃的缺陷。
    const cleaned = text.slice(0, parenIdx).replace(/["`]/g, "")
    this.recordCall(cleaned, ctx.start.line, "function")
    // 限定调用的包限定符额外记 packageRef：覆盖「被调用成员非子程序」（类型构造 pkg.t_rec_type(...)、
    // 集合访问 pkg.g_array(i)）及 directCall 后过滤丢弃但包依赖仍应保留的情形。真实调用的
    // packageDependency 边与 directCall 重复，由 dependency-graph 聚合去重。仅限定调用记（裸名调用
    // 无包限定符，resolveQualified 会退化为同包自引用，由后过滤同包丢弃，此处直接跳过省噪声）。
    if (cleaned.indexOf(".") > 0) {
      this.recordPackageRef(cleaned, ctx.start.line)
    }
  }

  private recordCallFromRoutine(_rn: Routine_nameContext | undefined, _line: number, _kind: "function" | "procedure") {
    // 保留签名兼容；实际 directCalls 经 enterCall_statement / enterStandard_function 走 recordCall
  }

  /** 把限定名拆为 package + name（走 resolveQualifiedName）；裸名归属调用方所属包；排除 SQL 伪列与自递归 */
  private recordCall(qualified: string, line: number, kind: "function" | "procedure") {
    if (this.subprogramStack.length === 0) return
    const caller = this.subprogramStack[this.subprogramStack.length - 1]
    const { pkg, member: method } = resolveQualifiedName(qualified, caller.belongToPackage)
    if (method.length < 2 || SQL_PSEUDO.has(method)) return
    // 排除 :NEW/:OLD 绑定变量上下文（routine_name 不会匹配，但防 :NEW.X 误入）
    if (pkg === "NEW" || pkg === "OLD") return
    // 同名包内调用（method === caller.name）**不在此丢弃**：可能是跨重载调用
    //（如 receive_stock overload 2 裸名委托 overload 1）。此处若按"自递归"丢弃，会让
    // callGraph 缺 __2→__1 边 → 拓扑层级算反 → __2 先于 __1 翻译 → 前向引用 TODO。
    // 真自递归（非重载，或重载但确为自身）由 dependency-graph.ts 的 resolveCalleeRefNames
    // 展开同名全部重载 refName + `if (calleeKey === callerKey) continue` 自环跳过兜住。
    caller.directCalls.push({ package: pkg, name: method, line, kind })
  }

  /** 记录跨包非调用引用（pkg.const / pkg.type / schema.pkg.const）。走 resolveQualifiedName 归一化，
   *  仅原始入栈，后过滤按已知包名收窄。 */
  private recordPackageRef(qualified: string, line: number) {
    if (this.subprogramStack.length === 0) return
    const caller = this.subprogramStack[this.subprogramStack.length - 1]
    const { pkg, member } = resolveQualifiedName(qualified, caller.belongToPackage)
    if (pkg.length < 2 || member.length < 2) return
    if (pkg === "NEW" || pkg === "OLD") return
    caller.packageRefs.push({ package: pkg, name: member, line })
  }

  // 声明中的跨包类型引用（v_row const_pkg.t_rec; / p in other_pkg.t_rec）走 type_name，
  // 不进 general_element。捕获 dotted type_name，后过滤按已知包名收窄（原生类型走 datatype 不进 type_name；
  // table.col%TYPE 的 table 非包被过滤）。
  enterType_name(ctx: any) {
    if (this.subprogramStack.length === 0) return
    // 与 enterGeneral_element 一致：去引号，走 recordPackageRef→resolveQualified 按段数归一化，
    // 正确处理 dotted 包名（fm.xxx.t_rec → 包限定符 fm.xxx）与 schema 限定。原生类型（NUMBER 等）
    // 走 datatype 不进此规则。
    const cleaned = ctxText(ctx).replace(/["`]/g, "")
    if (!cleaned.includes(".")) return  // 裸类型名，无包限定符
    this.recordPackageRef(cleaned, ctx.start.line)
  }

  // ParseTreeListener 必需的 4 个 no-op
  enterEveryRule() {}
  exitEveryRule() {}
  visitTerminal() {}
  visitErrorNode() {}
}

// ── 参数 / 返回类型抽取 ─────────────────────────────────────────────────────────

/** 从 ParameterContext[] 抽参数（name/type/mode/defaultExpression） */
function extractParams(params: ParameterContext[]): ParamInfo[] {
  const out: ParamInfo[] = []
  for (const p of params) {
    const name = cleanName(p.parameter_name()?.text ?? p.text ?? "")
    if (!name) continue
    const type = normalizeTypeText(ctxText(p.type_spec())) || "unknown"
    // antlr4ts 生成的 IN()/OUT()/INOUT() 返回 TerminalNode[]——空数组 [] 在 JS 中是 truthy，
    // 须用 .length > 0 判定（旧实现 !!p.OUT() 恒 true，导致所有参数 mode 误判为 "IN OUT"）。
    // grammar: parameter_name (IN | OUT | INOUT | NOCOPY)* type_spec? —— INOUT 单 token 等同 IN OUT。
    const inout = p.INOUT().length > 0
    const hasIn = p.IN().length > 0 || inout
    const hasOut = p.OUT().length > 0 || inout
    let mode: ParamInfo["mode"]
    if (hasIn && hasOut) mode = "IN OUT"
    else if (hasOut) mode = "OUT"
    else mode = "IN"
    const expr = p.default_value_part()?.expression()
    const defaultExpression = expr ? normalizeTypeText(ctxText(expr)) : null
    out.push({ name, type, mode, defaultExpression })
  }
  return out
}

/** 从 function spec/body ctx 取 RETURN 后的返回类型（第一个 type_spec） */
function extractReturnType(ctx: Function_specContext | Function_bodyContext): string | null {
  // RETURN type_spec ... —— 取 ctx 内的 type_spec（function spec/body 含一个 type_spec 为返回类型）
  const ts = ctx.type_spec()
  if (ts) return normalizeTypeText(ctxText(ts)) || null
  return null
}

// ── 单文件 AST 解析 ──────────────────────────────────────────────────────────────

/**
 * 单文件 AST 解析：lex/parse/walk，把包结构累积进共享 Map。
 * scanFileSet 调用；listener 跨文件 header/body 合并依赖同 file-set 内共享 Map。
 * 失败不抛：收集 warning 跳过该文件（默认错误恢复，与原内联 try 行为一致）。
 * 原实现 catch 里调 getLogger().warn；叶子模块不拉 workflow-logger，仅 push warning，
 * 调用方（scanFileSet 的调用者）按需日志。
 */
export function parseFileAst(
  code: string,
  relPath: string,
  packages: Map<string, PackageInfo>,
  subprograms: Map<string, SubprogramInfo[]>,
  standaloneProcedures: StandaloneProcIndex[],
  standaloneSlots: SubprogramInfo[],
  warnings: string[],
): void {
  // 收集语法/词法错误为 warning：antlr 默认错误恢复【不抛错】，语法错误会被静默恢复成部分树，
  // 可能导致子程序漏捕（「包识别但无子程序」类问题的根因常在此）。默认 ConsoleErrorListener
  // 已由 removeErrorListeners() 移除，此处挂收集型 listener 把错误按文件+行号记入 warnings，
  // 调用方（finalizeInventoryIndex）再透传 workflow.log，便于追查。
  // 全量打印（不截断）：排查方言语法问题需要完整错误分布；方言支持完善后 warning 数量自然下降。
  let syntaxErrors = 0
  const errorListener = {
    syntaxError(_r: unknown, _s: unknown, line: number, col: number, msg: string): void {
      syntaxErrors++
      warnings.push(`AST 语法错误: ${relPath} 行 ${line}:${col} ${msg}`)
    },
  }
  try {
    const lex = new PlSqlLexer(new UpperCaseCharStream(CharStreams.fromString(code)))
    const tokens = new CommonTokenStream(lex)
    const parser = new PlSqlParser(tokens)
    lex.removeErrorListeners()
    parser.removeErrorListeners()
    lex.addErrorListener(errorListener as any)
    parser.addErrorListener(errorListener as any)
    const tree = parser.sql_script()
    const listener = new PlSqlStructListener(relPath, packages, subprograms, standaloneProcedures, standaloneSlots, warnings, tokens)
    ParseTreeWalker.DEFAULT.walk(listener as any, tree)
    if (syntaxErrors > 0) {
      warnings.push(`AST 语法错误: ${relPath} 共 ${syntaxErrors} 条`)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    warnings.push(`AST 解析失败，跳过该文件的包结构: ${relPath} — ${msg}`)
  }
}

// ── 表 / 触发器 / 视图 / 序列 文本提取 ────────────────────────────────────────────

/** 计算子串在全文中的起止行号（1-based） */
export function lineRangeOf(code: string, startIdx: number, endIdx: number): [number, number] | undefined {
  if (startIdx < 0) return undefined
  const startLine = code.slice(0, startIdx).split("\n").length
  const endLine = code.slice(0, endIdx).split("\n").length
  return [startLine, endLine]
}

/** 转义正则元字符（标识符一般无元字符，但引号标识符可能含特殊字符，保险起见） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * 在包体/包头文件文本里，按 (包名, 子程序名, 类型, 重载序号) 定位声明行号范围。
 *
 * AST 语法错误恢复可能漏抽子程序节点致 bodyLocation/headerLocation 为 null（见 parseFileAst 注释），
 * 本函数用纯 regex 兜底补齐，绕过语法错误恢复：
 *   start = 顶层 (PROCEDURE|FUNCTION) METHOD 声明行（按 overloadIndex 1-based 取第 N 个，null 取第 1 个）；
 *   end   = start 到下一个顶层子程序声明前(或包 END PKG; 前)区间内最后一个 END [METHOD]; 行；
 *           区间内无 END（如 spec 声明无 END）则退到区间末行。
 * 大小写全程不敏感（i flag）：parseFileAst 用 UpperCaseCharStream 使 name 存大写，源码可能小写/混合写，
 * 不敏感匹配才能对上。嵌套块的 END IF;/END LOOP;/END CASE 不匹配（其后跟标识符再分号，不符合 end\s+(name)?\s*;）。
 * 找不到返回 null（调用方记 TODO warning，location 保持 null）。
 */
export function locateSubprogramRange(
  code: string,
  pkgName: string,
  methodName: string,
  type: "PROCEDURE" | "FUNCTION",
  overloadIndex: number | null,
): { lineRange: [number, number] } | null {
  const kw = type === "PROCEDURE" ? "procedure" : "function"
  const nameRe = escapeRegExp(methodName)

  // start：收集所有顶层声明匹配的字符偏移，按重载序号取第 N 个。
  // 前导用 [ \t]* 而非 \s*：\s 含换行，声明前有空行时 ^ 会锚到空行行首、\s* 吞掉空行+\n+下行缩进
  // 再匹配关键字，致 match.index 落到空行（行号错）。[ \t]* 只匹配同行空白。
  const startG = new RegExp(`^[ \\t]*${kw}\\s+${nameRe}\\b`, "gim")
  const starts: number[] = []
  let m: RegExpExecArray | null
  while ((m = startG.exec(code)) !== null) {
    starts.push(m.index)
    if (m.index === startG.lastIndex) startG.lastIndex++ // 防零宽死循环
  }
  const n = overloadIndex ?? 1
  if (n < 1 || n > starts.length) return null
  const startIdx = starts[n - 1]

  // 区间上界：下一个顶层子程序声明，或包 END PKG;，或文件末尾。
  // 注意：非全局 regex 的 lastIndex 被忽略（总从开头搜），必须用 g flag 才能从 startIdx 之后找。
  const nextDeclRe = new RegExp(`^[ \\t]*(?:procedure|function)\\s+\\w+`, "gim")
  nextDeclRe.lastIndex = startIdx + 1
  const declM = nextDeclRe.exec(code)
  let upperIdx: number
  if (declM && declM.index > startIdx) {
    upperIdx = declM.index
  } else {
    const pkgEndRe = new RegExp(`^[ \\t]*end\\s+${escapeRegExp(pkgName)}\\b\\s*;`, "gim")
    pkgEndRe.lastIndex = startIdx + 1
    const pkgM = pkgEndRe.exec(code)
    upperIdx = pkgM && pkgM.index > startIdx ? pkgM.index : code.length
  }

  // end：[startIdx, upperIdx) 内最后一个 END [METHOD]; 行（END transfer_money; / END;）。
  const endRe = new RegExp(`^[ \\t]*end\\s+(?:${nameRe})?\\s*;`, "gim")
  endRe.lastIndex = startIdx + 1
  let lastEndIdx = -1
  let em: RegExpExecArray | null
  while ((em = endRe.exec(code)) !== null) {
    if (em.index >= upperIdx) break
    lastEndIdx = em.index + em[0].length - 1
  }
  const endIdx = lastEndIdx >= 0 ? lastEndIdx : Math.max(startIdx, upperIdx - 1)

  const lineRange = lineRangeOf(code, startIdx, endIdx)
  return lineRange ? { lineRange } : null
}

/**
 * 正则兜底从子程序 body 文本抽取直接调用（directCalls）。
 *
 * 触发场景：AST 语法错误恢复漏抽调用节点 / 漏抽 caller body 节点 → directCalls 为空
 *（不像 bodyLocation 有 locateSubprogramRange 兜底，directCalls 原本无 regex 兜底）。
 * GaussDB 项目用 Oracle 改编 grammar 解析错误率较高，故对 directCalls 为空的子程序
 * 用正则从 body 区间文本抽调用，三段调用形式（schema.pkg.proc / pkg.proc / proc）全兼容。
 *
 * 语义对齐 AST 路径（recordCall + finalizeInventoryIndex 后过滤）：
 *   - 三段归一化走 resolveQualifiedName（单一真相源）；
 *   - 噪声过滤：member<2 / SQL_PSEUDO / pkg=NEW|OLD 丢弃（同 recordCall）；
 *   - 已知子程序收窄：仅保留 subprogramIndex 命中的 callee（同 finalizeInventoryIndex），
 *     自动滤除类型构造器 pkg.t_rec_type(...)、集合访问 pkg.g_array(i)、变量方法、SQL 内建函数；
 *   - 排除声明头：前驱 token 为 procedure/function 的 match 跳过（PROCEDURE pkg.proc(...) 声明），
 *     保留 CALL pkg.proc(...) 里的调用。
 * kind 统一标 "procedure"（regex 不区分过程/函数调用；callGraph 构边只用 package/name）。
 *
 * @param code  整个包 body 文件文本（须先经 normalizeFullwidthSyntax）
 * @param callerPkg  caller 声明键（belongToPackage，含 schema 前缀），供 resolveQualifiedName 锚定
 * @param lineRange  caller 的 bodyLocation.lineRange，限定只抽该区间内的调用（区间隔离）
 * @param subprogramIndex  PKG(大写)→Set<METHOD(大写)>，已知子程序收窄；传 null 不收窄（scan 阶段
 *                   闭包扩展要跟到尚未扫描的包，收窄会丢边；噪声留待 finalizeInventoryIndex 后过滤）
 */
export function extractCallsByRegex(
  code: string,
  callerPkg: string,
  lineRange: [number, number],
  subprogramIndex: Map<string, Set<string>> | null,
): DirectCall[] {
  // 调用点：标识符（可含 $ #）+ 可选 .ident 重复 + 紧跟左括号 = 调用。单捕获组取完整限定名
  //（覆盖 proc(...) / pkg.proc(...) / schema.pkg.proc(...)）。g+i 不敏感，归一化走 resolveQualifiedName。
  const callRe = /((?:"[^"]*"|[A-Za-z_][\w$#]*)(?:\.(?:"[^"]*"|[A-Za-z_][\w$#]*))*)\s*\(/gi
  // 预计算行起始偏移，二分把 match 偏移映回 1-based 行号，避免每次 O(n) slice（大 body 文件）。
  // 剥注释（行注释 -- / 块注释 /* */），用等量空格+换行替换保持 offset 与行号对齐，
  // 避免抽到注释里写的调用（AST 不解析注释，regex 兜底须对齐）。字符串字面量内的 -- 罕见，
  // 且调用点 '(' 通常在 -- 之前已匹配，误剥不影响调用抽取。
  const src = code
    .replace(/--[^\n]*/g, s => " ".repeat(s.length))
    .replace(/\/\*[\s\S]*?\*\//g, s => {
      const nl = (s.match(/\n/g) || []).length
      return " ".repeat(s.length - nl) + "\n".repeat(nl)
    })
  // 预计算行起始偏移，二分把 match 偏移映回 1-based 行号，避免每次 O(n) slice（大 body 文件）。
  const lineStarts: number[] = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1)
  const lineOf = (offset: number): number => {
    let lo = 0, hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1
      if (lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  const out: DirectCall[] = []
  const seen = new Set<string>()
  // 处理一个调用点（带括号 / 行首无括号共用）。idx = qualified 起始偏移（算行号 + 声明头检查用）。
  const addCall = (idx: number, qualified: string): void => {
    const line = lineOf(idx)
    if (line < lineRange[0] || line > lineRange[1]) return  // 区间外，跳过（区间隔离）
    // 排除声明头：match 所在行行首（去前导空白）为 procedure/function 关键字 → 声明而非调用，跳过。
    // 覆盖 PROCEDURE pkg.proc(...) / FUNCTION func(...) 声明头（含 idx=0 无前驱的文件首行情形）。
    const lineStart = lineStarts[line - 1]
    if (/^\s*(procedure|function)\b/i.test(src.slice(lineStart, idx))) return

    const { pkg, member } = resolveQualifiedName(qualified, callerPkg)
    if (member.length < 2 || SQL_PSEUDO.has(member)) return   // 噪声过滤（同 recordCall）
    if (pkg === "NEW" || pkg === "OLD") return                // :NEW/:OLD 绑定变量
    if (subprogramIndex !== null) {                           // 已知子程序收窄（同 finalizeInventoryIndex）
      const methods = subprogramIndex.get(pkg)                // scan 阶段传 null 不收窄：闭包扩展要跟到未扫包，
      if (!methods || !methods.has(member)) return            // 噪声（类型构造/集合访问）留待后过滤在闭包扫完后收窄
    }
    const key = `${pkg}.${member}.${line}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ package: pkg, name: member, line, kind: "procedure" })
  }

  // 1) 带括号调用：ident(.ident)* 紧跟 '(' —— proc(...) / pkg.proc(...) / schema.pkg.proc(...)
  //    段支持引号标识符（"F_BASE"."DO_WORK"(...)，DBMS_METADATA 导出常见）。
  let m: RegExpExecArray | null
  while ((m = callRe.exec(src)) !== null) addCall(m.index, m[1])

  // 2) 行首无括号过程调用：PL/SQL 过程调用语句可无括号（local_a; / pkg.proc; / schema.pkg.proc;）。
  //    仅匹配行首（去前导空白），避免表达式内的变量/类型误匹配。声明头（PROCEDURE name IS）不匹配
  //    （后跟 IS 不是 ;）。关键字语句（NULL;/RETURN;/END;）由后过滤收窄丢弃。
  const callNoParenRe = /^[ \t]*((?:"[^"]*"|[A-Za-z_][\w$#]*)(?:\.(?:"[^"]*"|[A-Za-z_][\w$#]*))*)\s*;/gim
  let m2: RegExpExecArray | null
  while ((m2 = callNoParenRe.exec(src)) !== null) {
    const qualifiedStart = m2.index + m2[0].indexOf(m2[1])  // 跳过 ^[ \t]* 前导空白到 qualified 起始
    addCall(qualifiedStart, m2[1])
  }
  return out
}

// ── regex 主路径：子程序结构识别（无 AST）──────────────────────────────────────

export interface SubprogramRange {
  name: string
  type: "PROCEDURE" | "FUNCTION"
  startLine: number
  endLine: number
  /** 'header' = spec 声明（分号结尾无 body）；'body' = 实现（IS/AS ... END [name];） */
  kind: "header" | "body"
  /** 所属包（含 schema，状态机跟踪 CREATE PACKAGE [BODY] schema.name） */
  pkgName: string
}

/**
 * regex 状态机识别**包级**子程序（过滤嵌套局部过程），返回 {name, type, startLine, endLine, kind}[]。
 * 纯 regex 主路径用（AST 不启用）。字符串/注释/括号深度感知：
 *   - 字符串字面量、双引号标识符、行注释、块注释内的关键字不计；
 *   - 参数列表括号内的 `;`/`IS`/`END` 不计（parenDepth>0）。
 *
 * 子程序 + 匿名块统一栈（kind:'sub'|'block'）：
 *   - `PROCEDURE|FUNCTION name`（parenDepth==0）→ 压 sub{isTopLevel: 栈中无 sub}；
 *   - `IS|AS`（栈顶 sub && !hasBody）→ hasBody=true（body 实现）；
 *   - `;`（栈顶 sub && !hasBody）→ spec 声明，弹栈记录 header；
 *   - `BEGIN` → 压 block（匿名块/子程序 body 开始）；
 *   - `END`：后跟 `IF|LOOP|CASE` 不计（控制流）；后跟 name`;` → 弹到匹配 name 的 sub（中间嵌套丢弃），
 *     isTopLevel 则记录 body；`END;`（无 name）→ 弹栈顶，sub && isTopLevel 则记录 body。
 * 包级 = isTopLevel（压栈时栈中无 sub）。嵌套局部过程 isTopLevel=false，不记录。
 *
 * 局限：token 识别按字符扫描，不跨行读 word（标识符不含换行，子程序声明 `PROCEDURE name` 同行）；
 * 包级 `END pkg;`（包结束）栈已空，容错弹空栈无操作。
 */
export function findAllSubprograms(code: string): SubprogramRange[] {
  const out: SubprogramRange[] = []
  const n = code.length
  let i = 0
  let line = 1
  let parenDepth = 0
  let state: "CODE" | "STR" | "DID" | "LINE" | "BLK" = "CODE"
  // 栈项：sub {kind:'sub', name, type, startLine, isTopLevel, hasBody, bodyStarted} | block {kind:'block'}
  const stack: Array<{ kind: "sub" | "block"; name?: string; type?: "PROCEDURE" | "FUNCTION"; startLine?: number; isTopLevel?: boolean; hasBody?: boolean; bodyStarted?: boolean }> = []
  let pendingSub: { type: "PROCEDURE" | "FUNCTION"; startLine: number } | null = null
  // endState: null=无；"END"=读到 END 待 name/`;`；"END_NAME"=读到 END name 待 `;`（已弹栈）；
  //           "END_CONTROL"=END IF/LOOP/CASE（控制流，`;` 忽略）；"CASE_END"=CASE...END 待确认下一 word
  let endState: null | "END" | "END_NAME" | "END_CONTROL" | "CASE_END" = null
  // SQL CASE...END 的深度：遇 CASE（非 END CASE）++，遇 END 时若 >0 则 -- 并不当块 END（避免 SQL CASE
  // 的 END 误弹子程序栈）。PL/SQL END CASE 在 endState=END 分支按控制流处理（不进 caseDepth）。
  let caseDepth = 0
  // CREATE TYPE BODY 跟踪：其内 MEMBER FUNCTION/PROCEDURE 是类型方法，不抽为包级子程序/standalone。
  // CREATE TYPE（无 BODY）的成员在括号内（parenDepth>0），本就不处理。
  let pendingType = false
  let pendingTypeBody = false
  let typeName = ""
  let inTypeBody = false
  // 包上下文跟踪：CREATE [OR REPLACE] [EDITIONABLE] PACKAGE [BODY] schema.name IS|AS → currentPackage
  let currentPackage = ""
  let pendingCreate = false
  let pendingPkg = false
  let pkgNameAccum = ""
  const isWord = (c: string): boolean => /[A-Za-z0-9_$#]/.test(c)

  const recordSub = (s: typeof stack[number], endLine: number, kind: "header" | "body"): void => {
    if (s.kind === "sub" && s.isTopLevel && s.name && s.type && s.startLine != null) {
      // pkgName="" = standalone（无 CREATE PACKAGE），scanFileSetRegex 据此填 standaloneProcedures/Slots
      out.push({ name: cleanName(s.name), type: s.type, startLine: s.startLine, endLine, kind, pkgName: currentPackage })
    }
  }
  // END name; 弹到匹配 name 的 sub；中间嵌套丢弃。无匹配则弹栈顶（容错）。
  const popUntilName = (name: string): void => {
    let top: typeof stack[number] | undefined
    while (stack.length > 0) {
      const s = stack.pop()!
      if (s.kind === "sub" && s.name && cleanName(s.name) === cleanName(name)) { top = s; break }
      // 中间嵌套（block / 不匹配 sub）丢弃
    }
    if (top) recordSub(top, line, "body")
  }

  while (i < n) {
    const c = code[i]
    if (state === "STR") {
      if (c === "'") { if (code[i + 1] === "'") { i += 2; continue }; state = "CODE"; i++; continue }
      if (c === "\n") line++
      i++; continue
    }
    if (state === "DID") {
      if (c === '"') { if (code[i + 1] === '"') { i += 2; continue }; state = "CODE"; i++; continue }
      if (pendingPkg) pkgNameAccum += c   // 引号标识符包名段（SCHEMA."PKG" 的 PKG）
      i++; continue
    }
    if (state === "LINE") {
      if (c === "\n") { line++; state = "CODE" }
      i++; continue
    }
    if (state === "BLK") {
      if (c === "*" && code[i + 1] === "/") { i += 2; state = "CODE"; continue }
      if (c === "\n") line++
      i++; continue
    }
    // CODE
    if (c === "-" && code[i + 1] === "-") { state = "LINE"; i += 2; continue }
    if (c === "/" && code[i + 1] === "*") { state = "BLK"; i += 2; continue }
    if (c === "'") { state = "STR"; i++; continue }
    if (c === '"') { state = "DID"; i++; continue }
    if (c === "\n") { line++; i++; continue }
    if (c === "(") { parenDepth++; i++; continue }
    if (c === ")") { if (parenDepth > 0) parenDepth--; i++; continue }
    if (c === ".") {
      if (parenDepth === 0 && pendingPkg && pkgNameAccum) pkgNameAccum += "."  // SCHEMA."PKG" 的点
      i++; continue
    }
    if (c === ";") {
      if (parenDepth === 0) {
        if (endState === "END") {
          // END; （无 name）→ 弹栈顶（匿名块或无 name 子程序）
          const top = stack.pop()
          if (top) recordSub(top, line, "body")
          endState = null
        } else if (endState === "CASE_END") {
          // CASE...END;（罕见，SQL CASE 后直接分号）→ caseDepth--
          caseDepth--
          endState = null
        } else if (endState === "END_NAME" || endState === "END_CONTROL") {
          // END name;（已弹栈）/ END IF;（控制流）→ 仅清状态，不再弹
          endState = null
        } else if (stack.length > 0) {
          // spec 声明：PROCEDURE name(params); （栈顶 sub 未遇 IS/AS）
          const top = stack[stack.length - 1]
          if (top.kind === "sub" && !top.hasBody) {
            stack.pop()
            recordSub(top, line, "header")
          }
        }
        pendingSub = null
      }
      i++; continue
    }
    if (isWord(c)) {
      const start = i
      while (i < n && isWord(code[i])) i++
      const word = code.slice(start, i).toUpperCase()
      if (parenDepth === 0) {
        if (pendingPkg) {
          // 收集 CREATE PACKAGE [BODY] schema.name 的包名（到 IS/AS 结束）
          if (word === "BODY") { /* 等 name */ }
          else if (word === "IS" || word === "AS") { currentPackage = cleanName(pkgNameAccum); pendingPkg = false; pkgNameAccum = "" }
          else { pkgNameAccum = pkgNameAccum + word }  // 不加点（点由 `.` 处理加，兼容引号段）
        } else if (pendingCreate) {
          if (word === "PACKAGE") { pendingPkg = true; pendingCreate = false }
          else if (word === "TYPE") { pendingType = true; pendingCreate = false }
          else if (word === "PROCEDURE" || word === "FUNCTION") {
            // CREATE [OR REPLACE] PROCEDURE/FUNCTION（standalone，无包）
            pendingSub = { type: word as "PROCEDURE" | "FUNCTION", startLine: line }; pendingCreate = false
          }
          else if (word === "OR" || word === "REPLACE" || word === "EDITIONABLE" || word === "NONEDITIONABLE") { /* 等 PACKAGE/TYPE/PROC */ }
          else { pendingCreate = false }
        } else if (pendingTypeBody) {
          typeName = word; inTypeBody = true; pendingTypeBody = false
        } else if (pendingType) {
          if (word === "BODY") { pendingTypeBody = true; pendingType = false }
          else { pendingType = false }  // CREATE TYPE spec：成员在括号内（parenDepth>0），本就不处理
        } else if (endState === "CASE_END") {
          // CASE...END 后确认下一 word：CASE → END CASE（PL/SQL，caseDepth-- 对应开始 CASE，本 CASE 不 ++）；
          // 非 CASE → SQL CASE END（caseDepth--，word 是 AS/FROM/列名，不处理）。两者都 caseDepth--。
          caseDepth--
          endState = null
          if (word !== "CASE") continue   // SQL END，后续 word（AS/FROM/列名）不处理
          continue                         // END CASE：本 CASE 不 caseDepth++，语句结束
        } else if (endState === "END") {
          if (inTypeBody && word === typeName) { inTypeBody = false; endState = null }  // CREATE TYPE BODY name 结束
          else if (inTypeBody) { endState = null }  // type body 内 member END name，忽略
          else if (word === "IF" || word === "LOOP" || word === "CASE") {
            endState = "END_CONTROL"           // 控制流 END IF/LOOP/CASE
          } else {
            popUntilName(word)                 // END name; —— 读到 name 即弹到匹配 sub
            endState = "END_NAME"
          }
        } else if (pendingSub) {
          stack.push({ kind: "sub", name: word, type: pendingSub.type, startLine: pendingSub.startLine, isTopLevel: !stack.some(s => s.kind === "sub"), hasBody: false })
          pendingSub = null
        } else if (word === "PROCEDURE" || word === "FUNCTION") {
          if (!inTypeBody) pendingSub = { type: word as "PROCEDURE" | "FUNCTION", startLine: line }
        } else if (word === "IS" || word === "AS") {
          if (stack.length > 0) {
            const top = stack[stack.length - 1]
            if (top.kind === "sub" && !top.hasBody) top.hasBody = true
          }
        } else if (word === "BEGIN") {
          // 子程序 IS 后首个 BEGIN = body 开始（不压 block，标 bodyStarted）；其余 BEGIN = 匿名块
          const top = stack.length > 0 ? stack[stack.length - 1] : null
          if (top && top.kind === "sub" && top.hasBody && !top.bodyStarted) {
            top.bodyStarted = true
          } else {
            stack.push({ kind: "block" })
          }
        } else if (word === "END") {
          if (caseDepth > 0) endState = "CASE_END"   // CASE...END，待下一 word 确认 SQL/PL
          else endState = "END"
        } else if (word === "CREATE") {
          pendingCreate = true
        } else if (word === "CASE") {
          caseDepth++   // SQL CASE 开始；PL/SQL END CASE 在 endState=END 分支按控制流处理
        }
      }
      continue
    }
    i++
  }
  return out
}

/**
 * regex 抽跨包非调用引用（pkg.const / pkg.type / schema.pkg.const）→ PackageRef[]。
 * 纯 regex 主路径用。复用 extractCallsByRegex 的剥注释 / 行号对齐 / 区间隔离 / 三段归一化，
 * 但匹配**无括号紧跟**的限定引用（至少 2 段），带括号的调用走 extractCallsByRegex。
 * 不收窄：scan 阶段不知全部已知包，噪声（localRecord.field / table.col）由 finalizeInventoryIndex
 * 后过滤按 knownPackages 收窄（同 AST 路径 packageRefs 后过滤）。
 *
 * @param code  整个包 body 文件文本（须先经 normalizeFullwidthSyntax）
 * @param callerPkg  caller 声明键（含 schema 前缀），供 resolveQualifiedName 锚定
 * @param lineRange  caller 的 bodyLocation.lineRange，限定只抽该区间内的引用
 */
export function extractPackageRefsByRegex(
  code: string,
  callerPkg: string,
  lineRange: [number, number],
): PackageRef[] {
  // 至少 2 段的限定引用（ident.ident[.ident]*）。后跟非 '(' 才算非调用引用。
  const refRe = /([A-Za-z_][\w$#]*(?:\.[A-Za-z_][\w$#]*)+)/g
  const src = code
    .replace(/--[^\n]*/g, s => " ".repeat(s.length))
    .replace(/\/\*[\s\S]*?\*\//g, s => {
      const nl = (s.match(/\n/g) || []).length
      return " ".repeat(s.length - nl) + "\n".repeat(nl)
    })
  const lineStarts: number[] = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1)
  const lineOf = (offset: number): number => {
    let lo = 0, hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1
      if (lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  const out: PackageRef[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = refRe.exec(src)) !== null) {
    const idx = m.index
    const line = lineOf(idx)
    if (line < lineRange[0] || line > lineRange[1]) continue  // 区间外
    // 后跟 '(' → 调用，走 directCalls，不记 packageRef
    let j = idx + m[0].length
    while (j < src.length && (src[j] === " " || src[j] === "\t")) j++
    if (src[j] === "(") continue
    const { pkg, member } = resolveQualifiedName(m[1], callerPkg)
    if (pkg.length < 2 || member.length < 2) continue   // 噪声过滤（同 recordPackageRef）
    if (pkg === "NEW" || pkg === "OLD") continue
    const key = `${pkg}.${member}.${line}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ package: pkg, name: member, line })
  }
  return out
}

/** 从文本提取表 + 列 + 主键 + 外键 */
export function extractTableFromText(code: string, tables: TableIndex[], relPath: string): void {
  for (const m of code.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+([\w.]+)/gi)) {
    const name = cleanName(m[1])
    const startIdx = m.index ?? 0
    // 表体到匹配的 ')' —— 简化：取到下一个 '\n/\n' 或下一个 CREATE 前
    const bodyEnd = nextStatementBoundary(code, startIdx)
    const fullBody = code.slice(startIdx, bodyEnd)
    // 列定义从表头的 '(' 之后开始——否则首行 "CREATE TABLE T_ITEM (" 会被列正则误匹配为
    // 列名 CREATE / 类型 TABLE（旧实现 body 从 CREATE 起切，首列产出垃圾 "CREATE"）。
    const parenIdx = fullBody.indexOf("(")
    const body = parenIdx >= 0 ? fullBody.slice(parenIdx + 1) : fullBody
    // 剥 /* */ 块注释（多行注释替换为等量换行，保持行结构/行号），否则注释中间行
    // `col_more NUMBER */` 会被列正则 ^(\w+)\s+(.+)$ 误判为幻影列。-- 行注释由各行尾处理。
    const bodyNoComments = body.replace(/\/\*[\s\S]*?\*\//g, m => "\n".repeat((m.match(/\n/g) || []).length))
    const columns: ColumnIndex[] = []
    const pkCols = new Set<string>()
    const foreignKeys: ForeignKeyInfo[] = []
    // 列定义逐行解析：name + rest（rest = 类型 + 约束 DEFAULT/NOT NULL/PRIMARY KEY 等，到逗号或行尾）。
    // 旧 multiline 正则只消费到类型，NOT NULL 等约束不在 rest 内 → nullable 误判。
    for (const rawLine of bodyNoComments.split("\n")) {
      const trimmed = rawLine.trim().replace(/,\s*$/, "")
      if (!trimmed) continue
      // 跳过外联约束行（CONSTRAINT / PRIMARY KEY ... 单独行）
      if (/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|KEY|NOT|NULL)\b/i.test(trimmed)) continue
      const m = trimmed.match(/^(\w+)\s+(.+)$/)
      if (!m) continue
      const colName = cleanName(m[1])
      if (!colName) continue
      const rest = m[2].trim()  // "VARCHAR2(40) NOT NULL" / "NUMBER(20,6) DEFAULT 0" / "t_dimension"
      // 类型 = 首个 token（含括号精度），去尾逗号（UDT 列无约束时 rest 即 "t_dimension,"）
      const typeMatch = rest.match(/^([\w(),.]+)/)
      const type = normalizeTypeText((typeMatch ? typeMatch[1] : rest).replace(/,\s*$/, ""))
      const notNull = /\bNOT\s+NULL\b/i.test(rest)
      const inlinePk = /\bPRIMARY\s+KEY\b/i.test(rest)
      // DEFAULT 值在 NOT NULL / 行尾前截断（避免吞下 "DEFAULT 'RAW' NOT NULL" 的 NOT NULL）
      const defMatch = rest.match(/DEFAULT\s+([^,]*?)(?:\s+NOT\s+NULL\b|\s*$)/i)
      columns.push({
        name: colName,
        oracleType: type,
        nullable: !(notNull || inlinePk),
        isPrimaryKey: inlinePk,
        defaultValue: defMatch ? normalizeTypeText(defMatch[1]) : null,
      })
      if (inlinePk) pkCols.add(colName)
    }
    // 外联约束
    for (const fk of bodyNoComments.matchAll(/CONSTRAINT\s+(\w+)\s+FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+([\w.]+)\s*\(([^)]+)\)/gi)) {
      foreignKeys.push({
        name: cleanName(fk[1]),
        columns: fk[2].split(",").map(c => cleanName(c)),
        refTable: cleanName(fk[3]),
        refColumns: fk[4].split(",").map(c => cleanName(c)),
      })
    }
    // 外联主键
    for (const pk of bodyNoComments.matchAll(/CONSTRAINT\s+\w+\s+PRIMARY\s+KEY\s*\(([^)]+)\)/gi)) {
      for (const c of pk[1].split(",")) pkCols.add(cleanName(c))
    }
    if (pkCols.size > 0) {
      for (const col of columns) if (pkCols.has(col.name)) { col.isPrimaryKey = true; col.nullable = false }
    }
    tables.push({
      name,
      ddlFile: relPath,
      columns,
      primaryKey: pkCols.size > 0 ? Array.from(pkCols) : undefined,
      foreignKeys: foreignKeys.length > 0 ? foreignKeys : undefined,
    })
  }
}

/** 找下一个语句边界（粗：下一个行首 CREATE 或文件末） */
export function nextStatementBoundary(code: string, from: number): number {
  const re = /\n\s*(CREATE|CREATE OR REPLACE)\b/gi
  re.lastIndex = from + 1
  const m = re.exec(code)
  return m ? m.index : code.length
}

/** 从原始文本提取触发器元数据 */
export function extractTriggerFromText(code: string, triggers: TriggerIndex[], relPath: string): void {
  const m = code.match(/CREATE\s+(OR\s+REPLACE\s+)?TRIGGER\s+([\w.]+)/i)
  if (!m) return
  const name = cleanName(m[2])
  const startIdx = m.index ?? 0
  const txt = code.slice(startIdx)
  const endRe = /\bEND\s*;/gi
  let lastEnd: RegExpExecArray | null = null
  let em: RegExpExecArray | null
  while ((em = endRe.exec(txt)) !== null) lastEnd = em
  const endIdx = lastEnd ? startIdx + lastEnd.index + lastEnd[0].length : code.length
  let timing: string | undefined
  if (/\bBEFORE\b/i.test(txt)) timing = "before"
  else if (/\bAFTER\b/i.test(txt)) timing = "after"
  else if (/\bINSTEAD\s+OF\b/i.test(txt)) timing = "instead-of"
  const level = /\bFOR\s+EACH\s+ROW\b/i.test(txt) ? "row" : "statement"
  const headerMatch = txt.match(/(?:BEFORE|AFTER|INSTEAD\s+OF)\s+(.+?)\s+ON\s+/is)
  const header = headerMatch ? headerMatch[1] : ""
  const events: string[] = []
  if (/\bINSERT\b/i.test(header)) events.push("insert")
  if (/\bUPDATE\b/i.test(header)) events.push("update")
  if (/\bDELETE\b/i.test(header)) events.push("delete")
  const onMatch = txt.match(/\bON\s+([\w.]+)/i)
  const targetTable = onMatch ? cleanName(onMatch[1]) : undefined
  const whenMatch = txt.match(/\bWHEN\s*\(([^)]*(?:\([^)]*\))*[^)]*)\)/i)
  const condition = whenMatch ? whenMatch[1].replace(/\s*\.\s*/g, ".").trim() : null
  triggers.push({
    name, sourceFile: relPath,
    timing, level, events, targetTable,
    lineRange: lineRangeOf(code, startIdx, endIdx),
    condition,
  })
}

/** 从原始文本提取视图元数据 */
export function extractViewFromText(code: string, views: ViewIndex[], relPath: string): void {
  const m = code.match(/CREATE\s+(OR\s+REPLACE\s+)?VIEW\s+([\w.]+)\s+AS\b/is)
  if (!m) return
  const name = cleanName(m[2])
  const body = code.slice((m.index ?? 0) + m[0].length)
  const selMatch = body.match(/SELECT\s+(.*?)\s+FROM\s+/is)
  const columns: string[] = []
  if (selMatch) {
    for (const part of selMatch[1].split(",")) {
      const mm = part.trim().match(/(\w+)\s*(?:\sAS\s*)?$/i)
      if (mm && mm[1] && !/^(SELECT|FROM|WHERE|AS|AND|OR)$/i.test(mm[1])) columns.push(mm[1])
    }
  }
  const underlyingTables: string[] = []
  const tableRe = /(?:FROM|JOIN)\s+([\w.]+)/gi
  let tm: RegExpExecArray | null
  while ((tm = tableRe.exec(body)) !== null) {
    const t = cleanName(tm[1])
    if (!underlyingTables.includes(t)) underlyingTables.push(t)
  }
  views.push({ name, ddlFile: relPath, columns, underlyingTables })
}

/** 从原始文本提取序列属性 */
export function extractSequenceFromText(code: string, sequences: SequenceIndex[], relPath: string): void {
  for (const m of code.matchAll(/CREATE\s+SEQUENCE\s+([\w.]+)/gi)) {
    const name = cleanName(m[1])
    const startIdx = m.index ?? 0
    const txt = code.slice(startIdx, nextStatementBoundary(code, startIdx))
    const num = (re: RegExp): number | null => { const x = txt.match(re); return x ? parseInt(x[1], 10) : null }
    sequences.push({
      name, ddlFile: relPath,
      startWith: num(/START\s+WITH\s+(\d+)/i),
      incrementBy: num(/INCREMENT\s+BY\s+(\-?\d+)/i),
      minValue: num(/MINVALUE\s+(\-?\d+)/i),
      maxValue: num(/MAXVALUE\s+(\-?\d+)/i),
      cycle: /\bCYCLE\b/i.test(txt) && !/\bNOCYCLE\b/i.test(txt) ? true
        : /\bNOCYCLE\b/i.test(txt) ? false : null,
    })
  }
}

// ── 路径规范化 ────────────────────────────────────────────────────────────────────

/** 存入 headerPath/bodyPath/absolutePath 的路径：返回绝对路径（规范 '/' 分隔）。
 *
 *  历史上在 primaryBase 下存相对、否则存绝对，致：①字段名 absolutePath 名不副实；
 *  ②两级目录模式（headerPath/bodyPath 为兄弟目录）下 header 相对、body 绝对，不一致；
 *  ③generateUnitSlices 需 join(sourcePath, rel) 还原，sourcePath 缺失（两级目录模式）时切片失败。
 *
 *  改存绝对：.workflow-artifacts 是 gitignore 的 run-local 产物，无跨机器移植需求；绝对路径使
 *  字段名副其实、header/body 一致、且 generateUnitSlices 的 isAbsolute 直走无需 sourcePath。
 *  全路径（含目录）天然唯一，同包 header/body 重名不碰撞（不同目录/扩展名 + 分属不同字段）。 */
export function storedFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/")
}

// ── 文件集扫描（worker 与主线程串行 fallback 共用）──────────────────────────────

/** 单个 file-set 的扫描产物。packages/subprograms 为扁平数组（subprograms 含同包重载多槽位，
 *  overloadIndex 由调用方 finalizeInventoryIndex 按 `PKG.METHOD` 重新分桶赋值）。
 *  **调用方须保证同一包的全部文件落在同一 file-set** → 跨 file-set 无同 key → 主线程拼接无需
 *  复现 listener 的 spec↔body 槽位配对（registerSubprogram 的 find-by-vacancy 已在 file-set 内完成）。 */
export interface FileSetResult {
  packages: PackageInfo[]
  subprograms: SubprogramInfo[]
  standaloneProcedures: StandaloneProcIndex[]
  standaloneSlots: SubprogramInfo[]
  tables: TableIndex[]
  triggers: TriggerIndex[]
  views: ViewIndex[]
  sequences: SequenceIndex[]
  warnings: string[]
}

/**
 * 在一组文件上跑 listener（共享 local Map 正确处理同包 spec/body 跨文件合并）+ 文本提取，
 * 返回扁平 FileSetResult。与原 scanWithAST 内层循环语义一致，仅作用域从「全部文件」收窄到
 * 「一个 file-set」，且返回结果而非直接 finalize。worker 池与串行 fallback 共用此函数。
 */
export function scanFileSet(filePaths: string[], primaryBase: string): FileSetResult {
  const packages = new Map<string, PackageInfo>()
  const subprograms = new Map<string, SubprogramInfo[]>()
  const tables: TableIndex[] = []
  const triggers: TriggerIndex[] = []
  const views: ViewIndex[] = []
  const sequences: SequenceIndex[] = []
  const standaloneProcedures: StandaloneProcIndex[] = []
  const standaloneSlots: SubprogramInfo[] = []
  const warnings: string[] = []
  const processed = new Set<string>()  // 按绝对路径去重

  for (const filePath of filePaths) {
    if (processed.has(filePath)) continue
    processed.add(filePath)
    const rawCode = readFileSync(filePath, "utf-8").replace(/\r\n?/g, "\n")
    const relPath = storedFilePath(filePath)
    // 先归一化全角语法符号（恢复被中文输入法全角化的字符串边界/分号/括号等，串内内容
    // 原样保留），再 strip SQL*Plus 命令——让 strip 能识别归一化后的执行符 /。
    const code = stripSqlPlusCommands(normalizeFullwidthSyntax(rawCode))

    // table/trigger/view/sequence 仍走文本提取（与包结构无关）
    extractTableFromText(code, tables, relPath)
    extractTriggerFromText(code, triggers, relPath)
    extractViewFromText(code, views, relPath)
    extractSequenceFromText(code, sequences, relPath)

    // 包/子程序/独立过程走 AST
    parseFileAst(code, relPath, packages, subprograms, standaloneProcedures, standaloneSlots, warnings)
  }

  // 扁平化 subprograms：保留同 key 槽位顺序（overloadIndex 顺序由 finalize 按 key 重分桶保持）
  const subprogramList: SubprogramInfo[] = []
  for (const slots of subprograms.values()) subprogramList.push(...slots)

  return {
    packages: Array.from(packages.values()),
    subprograms: subprogramList,
    standaloneProcedures,
    standaloneSlots,
    tables, triggers, views, sequences,
    warnings,
  }
}

/**
 * regex 主路径扫描一个 file-set（替代 scanFileSet 的 AST 路径，AST 保留不启用）。
 *
 * 每文件：extractPackageNames 建包 + findAllSubprograms 识别包级子程序（状态机，过滤嵌套局部过程）
 * + spec/body 槽位合并（同 registerSubprogram：spec 填 headerLocation，body 填 bodyLocation
 *   + directCalls/packageRefs）。parameters/returnType/包级声明留空，交 LLM 兜底（引擎按
 *   bodyLocation.lineRange 预切 source.sql 喂 translate LLM，见 workflow-engine.ts）。
 *
 * directCalls 走 extractCallsByRegex 不收窄（scan 阶段闭包扩展要跟到未扫包），噪声由
 * finalizeInventoryIndex 后过滤在闭包扫完后收窄。standalone（无包）文件 MVP 记 warning 跳过。
 */
export function scanFileSetRegex(filePaths: string[], primaryBase: string): FileSetResult {
  const packages = new Map<string, PackageInfo>()
  const subprograms = new Map<string, SubprogramInfo[]>()
  const tables: TableIndex[] = []
  const triggers: TriggerIndex[] = []
  const views: ViewIndex[] = []
  const sequences: SequenceIndex[] = []
  const standaloneProcedures: StandaloneProcIndex[] = []
  const standaloneSlots: SubprogramInfo[] = []
  const warnings: string[] = []
  const processed = new Set<string>()

  for (const filePath of filePaths) {
    if (processed.has(filePath)) continue
    processed.add(filePath)
    const rawCode = readFileSync(filePath, "utf-8").replace(/\r\n?/g, "\n")
    const relPath = storedFilePath(filePath)
    const code = stripSqlPlusCommands(normalizeFullwidthSyntax(rawCode))

    extractTableFromText(code, tables, relPath)
    extractTriggerFromText(code, triggers, relPath)
    extractViewFromText(code, views, relPath)
    extractSequenceFromText(code, sequences, relPath)

    const pkgNames = extractPackageNames(code)
    if (pkgNames.length === 0) {
      // 非包文件：DDL 已上面抽；standalone CREATE PROCEDURE/FUNCTION（无包）→ 填 standaloneProcedures/Slots，
      // 由 finalizeInventoryIndex 的 injectStandaloneVirtualPackages 注入虚拟包 __STANDALONE_x__（同 AST 路径）。
      for (const sub of findAllSubprograms(code)) {
        if (sub.pkgName !== "" || sub.kind !== "body") continue  // 仅 standalone body
        const range: [number, number] = [sub.startLine, sub.endLine]
        standaloneProcedures.push({
          name: sub.name, type: sub.type, sourceFile: relPath,
          parameters: [], returnType: null, lineRange: range,
        })
        standaloneSlots.push({
          name: sub.name, type: sub.type, belongToPackage: "" /* 占位，inject 回填虚拟包名 */,
          overloadIndex: null, isPrivate: false,
          headerLocation: null, bodyLocation: { absolutePath: relPath, lineRange: range },
          parameters: [], returnType: null, loc: sub.endLine - sub.startLine + 1,
          directCalls: extractCallsByRegex(code, "", range, null),
          packageRefs: extractPackageRefsByRegex(code, "", range),
        })
      }
      continue
    }
    const hasBody = /\bPACKAGE\s+BODY\b/i.test(code)
    // 建所有包（extractPackageNames 含 schema）；headerPath/bodyPath 按文件是否含 BODY 设（混合 spec+body 文件近似）
    for (const pn of pkgNames) {
      let pkg = packages.get(pn)
      if (!pkg) {
        pkg = {
          packageName: pn, absolutePaths: [], headerPath: null, bodyPath: null,
          constants: [], variables: [], exceptions: [], types: [], functions: [], procedures: [], estimatedLoc: 0,
        }
        packages.set(pn, pkg)
      }
      if (!pkg.absolutePaths.includes(relPath)) pkg.absolutePaths.push(relPath)
      if (hasBody) { if (!pkg.bodyPath) pkg.bodyPath = relPath } else { if (!pkg.headerPath) pkg.headerPath = relPath }
    }
    packages.get(pkgNames[0])!.estimatedLoc += code.split("\n").length  // 多包文件 LOC 归首个包（近似）

    for (const sub of findAllSubprograms(code)) {
      const pn = sub.pkgName
      if (!pn) continue  // standalone（无包）由上面 pkgNames.length===0 分支处理；包文件内混入的 standalone 跳过
      const key = `${pn}.${sub.name}`
      const slots = subprograms.get(key) ?? []
      // spec 填 headerLocation===null 槽位；body 填 bodyLocation===null 槽位（同 registerSubprogram）
      let slot: SubprogramInfo | undefined
      if (sub.kind === "body") slot = slots.find(s => s.bodyLocation === null)
      else slot = slots.find(s => s.headerLocation === null)
      if (!slot) {
        slot = {
          name: sub.name, type: sub.type, belongToPackage: pn, overloadIndex: null, isPrivate: false,
          headerLocation: null, bodyLocation: null, parameters: [], returnType: null, loc: 0,
          directCalls: [], packageRefs: [],
        }
        slots.push(slot)
        subprograms.set(key, slots)
      }
      const lineRange: [number, number] = [sub.startLine, sub.endLine]
      if (sub.kind === "body") {
        slot.bodyLocation = { absolutePath: relPath, lineRange }
        slot.loc = sub.endLine - sub.startLine + 1
        slot.directCalls = extractCallsByRegex(code, pn, lineRange, null)
        slot.packageRefs = extractPackageRefsByRegex(code, pn, lineRange)
      } else {
        slot.headerLocation = { absolutePath: relPath, lineRange }
      }
      slot.isPrivate = slot.headerLocation === null
    }
  }

  const subprogramList: SubprogramInfo[] = []
  for (const slots of subprograms.values()) subprogramList.push(...slots)

  return {
    packages: Array.from(packages.values()),
    subprograms: subprogramList,
    standaloneProcedures,
    standaloneSlots,
    tables, triggers, views, sequences,
    warnings,
  }
}
