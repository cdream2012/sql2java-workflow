/**
 * Analysis Builder — analyze map-reduce 的 **reduce**（代码，零 LLM），归入 inventory 阶段：
 *   - complexity：启发式（LOC + 子程序数 + 出边数 + 模式 grep）→ score/riskLevel/patterns，
 *     写入 packages/{PKG}.json（取代旧 dependency-graph.json.complexity，已删）。
 *   - 无子程序包的空 analysis-packages/{PKG}.json 兜底（有子程序的包由 analyze map 阶段填充）。
 *
 * callGraph / packageDependency / translationOrder / sccGroups / procedureOrder / functionOwnership
 * 不再落盘（dependency-graph.json 已删），由 dependency-graph.ts 从 subprograms/*.json 的 directCalls
 * 按需推导（进程内缓存）。本模块仅保留 complexity——它读源码做 grep 启发式，非纯图算法，
 * 不适合放进纯 artifact→图的 dependency-graph.ts。出边数复用 dependency-graph.ts 推导的 callGraph。
 *
 * 产出过 PackageArtifactSchema / AnalysisPackageSchema Zod 校验。
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs"
import { join, isAbsolute } from "node:path"
import { PackageArtifactSchema, AnalysisPackageSchema } from "./artifact-schemas"
import { formatZodIssues } from "./engine-core"
import { buildDependencyGraph } from "./dependency-graph"
import { pkgOf } from "./refname"
import { getLogger } from "./workflow-logger"

// ── packages/{PKG}.json 形态（宽松读取，complexity 由本模块回填）──
interface PackageArtifact {
  packageName: string
  headerPath: string | null
  bodyPath: string | null
  procedures: string[]
  functions: string[]
  estimatedLoc?: number
  [k: string]: unknown
}

/** 读源码文件（headerPath/bodyPath 相对 sourcePath，可能为绝对路径） */
function readSource(sourcePath: string, rel?: string | null): string {
  if (!rel) return ""
  const abs = isAbsolute(rel) ? rel : join(sourcePath, rel)
  if (!existsSync(abs)) return ""
  return readFileSync(abs, "utf-8").replace(/\r\n?/g, "\n")
}

/** 启发式复杂度：LOC + 子程序数 + 出边数 + 模式 grep → score/patterns/riskLevel */
function heuristicComplexity(
  pkg: PackageArtifact,
  bodyCode: string,
  headerCode: string,
  outgoingEdges: number,
): { score: number; patterns: string[]; riskLevel: "low" | "medium" | "high" } {
  const code = bodyCode + "\n" + headerCode
  const patternDefs: [string, RegExp][] = [
    ["cursor-loop", /\b(FOR\s+\w+\s+IN\s*\(|CURSOR\b|\bLOOP\b)/i],
    ["exception-block", /\bEXCEPTION\b/i],
    ["dynamic-sql", /(EXECUTE\s+IMMEDIATE|DBMS_SQL)/i],
    ["bulk-collect", /BULK\s+COLLECT/i],
    ["forall", /\bFORALL\b/i],
    ["merge", /\bMERGE\b/i],
    ["connect-by", /CONNECT\s+BY/i],
    ["analytic", /\bOVER\s*\(/i],
    ["pipelined", /(PIPELINED|PIPE\s+ROW)/i],
    ["autonomous-tx", /AUTONOMOUS_TRANSACTION/i],
  ]
  const patterns = patternDefs.filter(([, re]) => re.test(code)).map(([n]) => n)

  const loc = pkg.estimatedLoc ?? 0
  const subprogramCount = pkg.procedures.length + pkg.functions.length
  let score = Math.round(loc / 100 + subprogramCount * 0.4 + outgoingEdges * 0.3 + patterns.length * 0.6)
  if (score < 1) score = 1
  if (score > 10) score = 10
  const riskLevel: "low" | "medium" | "high" = score <= 3 ? "low" : score <= 6 ? "medium" : "high"
  return { score, patterns, riskLevel }
}

/** 读 inventory.json 的 sourcePath + packageNames（顶层索引，轻量） */
function readInventoryMeta(artifactsDir: string): { sourcePath: string; packageNames: string[] } {
  const p = join(artifactsDir, "inventory.json")
  if (!existsSync(p)) {
    throw new Error(`inventory.json 不存在: ${p}（generateInventory 可能未运行）`)
  }
  const inv = JSON.parse(readFileSync(p, "utf-8")) as { sourcePath?: string; packageNames?: string[] }
  return {
    sourcePath: inv.sourcePath ?? "",
    packageNames: Array.isArray(inv.packageNames) ? inv.packageNames : [],
  }
}

/** 读 packages/*.json 全部包（按文件名序） */
function readPackages(artifactsDir: string): PackageArtifact[] {
  const dir = join(artifactsDir, "packages")
  if (!existsSync(dir)) return []
  const out: PackageArtifact[] = []
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf-8")) as PackageArtifact)
    } catch { /* 跳过损坏文件 */ }
  }
  return out
}

/**
 * 读 inventory.json + packages/*.json，把启发式 complexity 写回 packages/{PKG}.json，
 * 并为无子程序包写空 analysis-packages/{PKG}.json 兜底。任一产物 Zod 校验失败即抛错。
 *
 * callGraph/SCC/ordering 不再在此产出——由 dependency-graph.ts 按需推导（见该模块）。
 */
export function buildDependencyGraphFromIndex(artifactsDir: string): {
  packageCount: number
  sccGroupCount: number
  warnings: string[]
} {
  const warnings: string[] = []
  const { sourcePath } = readInventoryMeta(artifactsDir)
  const packages = readPackages(artifactsDir)

  // 出边数（按包聚合）——复用 dependency-graph.ts 从 subprograms.directCalls 推导的 callGraph
  const graph = buildDependencyGraph(artifactsDir)
  const outgoingByPkg: Record<string, number> = {}
  for (const [caller, callees] of Object.entries(graph.callGraph)) {
    const p = pkgOf(caller)
    outgoingByPkg[p] = (outgoingByPkg[p] ?? 0) + callees.length
  }

  // complexity 写入 packages/{PKG}.json（合并回写，保留其它字段）
  for (const pkg of packages) {
    const bodyCode = readSource(sourcePath, pkg.bodyPath)
    const headerCode = readSource(sourcePath, pkg.headerPath)
    const complexity = heuristicComplexity(pkg, bodyCode, headerCode, outgoingByPkg[pkg.packageName] ?? 0)
    const merged = { ...pkg, complexity }
    const r = PackageArtifactSchema.safeParse(merged)
    if (!r.success) {
      throw new Error(`packages/${pkg.packageName}.json 合并 complexity 后校验失败:\n${formatZodIssues(r.error)}`)
    }
    writeFileSync(join(artifactsDir, "packages", `${pkg.packageName}.json`), JSON.stringify(r.data, null, 2), "utf-8")
  }

  // 无子程序包写空 analysis-packages/{PKG}.json（有子程序的包由 analyze map 阶段填充）
  const analysisPkgDir = join(artifactsDir, "analysis-packages")
  mkdirSync(analysisPkgDir, { recursive: true })
  for (const pkg of packages) {
    if (pkg.procedures.length > 0 || pkg.functions.length > 0) continue
    const empty = { packageName: pkg.packageName, subprograms: [] }
    const r = AnalysisPackageSchema.safeParse(empty)
    if (!r.success) {
      throw new Error(`analysis-packages/${pkg.packageName}.json 空文件校验失败:\n${formatZodIssues(r.error)}`)
    }
    writeFileSync(join(analysisPkgDir, `${pkg.packageName}.json`), JSON.stringify(r.data, null, 2), "utf-8")
  }

  getLogger().info("[analysis-builder]", `complexity 写入 ${packages.length} 个 packages/*.json; 依赖图按需推导: ${graph.sccGroups.length} SCC 组, ${graph.procedureOrder.flat().length} PROCEDURE 单元, ${Object.keys(graph.functionOwnership).length} 被拥有 FUNCTION`)
  return { packageCount: packages.length, sccGroupCount: graph.sccGroups.length, warnings }
}
