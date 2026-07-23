/**
 * scaffold-input-builder — scaffold 派发前的确定性预聚合（零 LLM，packages-only）
 *
 * 仿 review-scanner.ts 的 scanReviewStatic：dispatch 前 engine 调 generateScaffoldInput，
 * 读 inventory.json + packages/*.json，抽出 scaffold 真正消费的窄字段，聚合成一份紧凑
 * scaffold-input.json 落盘。scaffold 子 agent 只读这一份，不再挨个 Read 原始 artifact。
 *
 * tables/sequences/views **不在此**——DO 实体 + schema-h2.sql 由 do-schema-builder 引擎在
 * scaffold 完成后确定性生成（读 tables/*.json + inventory 直接落盘），表数据全程不进 LLM 上下文。
 *
 * 设计见 [[scaffold-input-aggregation]]。scaffold 消费的上游数据（java-architect.md Step 0.4/5）：
 *   - inventory.json：packageNames（稳定顺序）
 *   - packages/{name}.json：packageName、sourcePath、constants、variables、procedures（名）、functions（名）
 *
 * 注：扫描器按设计把包级 constants/variables 留空交 LLM 兜底，故每个包带上 sourcePath，
 * scaffold 在 constants/variables 为空时读该 sourcePath 的 source.sql 抽取兜底。
 * procClassNames 去重依赖稳定顺序（packageNames 序 → 包内 procedures/functions 序），聚合保持原序。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getLogger } from "./workflow-logger"

/** 读 JSON 文件（不存在/解析失败返回 null）。镜像 workflow-engine.readJsonOrNull，保持自包含。 */
function readJsonOrNull(path: string): any {
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, "utf-8")) } catch { return null }
}

/** 聚合后的紧凑 scaffold 输入。仅含 scaffold 消费字段。 */
export interface ScaffoldInput {
  packageNames: string[]
  packages: Array<{
    packageName: string
    sourcePath: string | null
    constants: unknown[]
    variables: unknown[]
    procedures: string[]
    functions: string[]
  }>
}

/**
 * 从 inventory + packages 聚合 scaffold-input.json（packages-only），落盘到 artifactsDir。
 * tables/sequences/views 不在此——DO 实体 + schema-h2.sql 由 do-schema-builder 引擎确定性生成，
 * 表数据全程不进 LLM 上下文。单文件缺失/解析失败 → warn 跳过，不阻断 dispatch。
 */
export function generateScaffoldInput(artifactsDir: string): ScaffoldInput {
  const log = getLogger()
  const inv = readJsonOrNull(join(artifactsDir, "inventory.json"))
  if (!inv) {
    log.warn("[scaffold-input]", `inventory.json 缺失/不可解析：${artifactsDir}/inventory.json，跳过聚合`)
    return { packageNames: [], packages: [] }
  }

  const packageNames: string[] = Array.isArray(inv.packageNames) ? inv.packageNames : []

  // packages：仅保留 scaffold 消费字段 + sourcePath（constants/variables 空时兜底读源码用）
  const packages = packageNames.map((pn) => {
    const pkg = readJsonOrNull(join(artifactsDir, "packages", `${pn}.json`))
    if (!pkg) {
      log.warn("[scaffold-input]", `packages/${pn}.json 缺失/不可解析，跳过`)
      return { packageName: pn, sourcePath: null, constants: [], variables: [], procedures: [], functions: [] }
    }
    const abs = Array.isArray(pkg.absolutePaths) && pkg.absolutePaths.length > 0 ? pkg.absolutePaths[0] : null
    const sourcePath = abs ?? pkg.headerPath ?? null
    return {
      packageName: pkg.packageName ?? pn,
      sourcePath,
      constants: Array.isArray(pkg.constants) ? pkg.constants : [],
      variables: Array.isArray(pkg.variables) ? pkg.variables : [],
      procedures: Array.isArray(pkg.procedures) ? pkg.procedures : [],
      functions: Array.isArray(pkg.functions) ? pkg.functions : [],
    }
  })

  const out: ScaffoldInput = { packageNames, packages }
  writeFileSync(join(artifactsDir, "scaffold-input.json"), JSON.stringify(out, null, 2))
  log.info("[scaffold-input]", `聚合完成：${packages.length} 包 → ${join(artifactsDir, "scaffold-input.json")}`)
  return out
}
