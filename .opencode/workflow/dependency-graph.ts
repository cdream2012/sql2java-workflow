/**
 * Dependency Graph — 按需推导的调用图工具
 *
 * 从 inventory 阶段产出的 subprograms/{PKG.METHOD}.json 的 directCalls 在内存构建调用图，
 * 提供 callGraph / packageDependency / 闭包 / Tarjan SCC 翻译序 / 过程级拓扑序。
 *
 * 取代旧 dependency-graph.json（已删）：调用边不再落盘，按需从 directCalls 推导（进程内缓存）。
 * 算法（tarjanSCC / buildProcedureOrder）迁移自 analysis-builder。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { refNameOf, pkgOf } from "./refname"
import { getLogger } from "./workflow-logger"

// ── 类型 ────────────────────────────────────────────────────────────────────────

interface SubprogramFile {
  name: string
  type: "PROCEDURE" | "FUNCTION"
  belongToPackage: string
  overloadIndex: number | null
  isPrivate: boolean
  directCalls: { package: string; name: string; line: number; kind: "function" | "procedure" }[]
  packageRefs?: { package: string; name: string; line: number }[]
  /** body 源码定位（scanner 落盘）；用于按源码行数做分片大小估算 */
  bodyLocation?: { lineRange?: [number, number] } | null
}

export interface RefIndexEntry {
  /** 本包子程序（含 refName / type），顺序与文件 encounter 一致 */
  subprograms: { name: string; refName: string; type: "procedure" | "function" }[]
  /** 大写裸名 → 该名的所有 refName（重载多版本） */
  procNameToRefNames: Map<string, string[]>
}

export interface DependencyGraph {
  /** 子程序级调用图：key=`PKG.refName`，value=被调用的 `PKG.refName` 数组 */
  callGraph: Record<string, string[]>
  /** 包级依赖：PKG → 依赖的 PKG[]（去重，排除自环） */
  packageDependency: Record<string, string[]>
  /** 包名列表 */
  packageNames: string[]
  /** refName 索引 */
  refIndex: Map<string, RefIndexEntry>
  /** 包级翻译序（Tarjan SCC，依赖在前） */
  translationOrder: string[][]
  /** size>1 的 SCC 组 */
  sccGroups: string[][]
  /** 过程级单元拓扑序（每个 subprogram 独立成 unit，依赖在前） */
  procedureOrder: string[][]
  /** unit id `PKG.refName` → body 源码行数（取自 bodyLocation.lineRange）；缺则 0。
   *  供 computeShardPlan 按行数预算切分（避免大 unit 撑爆上下文）。 */
  unitLines: Record<string, number>
  /** unit id `PKG.refName` → 拓扑层级（到叶子的最长路径，叶子=0）；多 unit SCC 整体取成员最高层。
   *  供 computeShardPlan 按层 antichain 批量：同层 unit 互不调用（u→v 必 level(v)≥level(u)+1），
   *  可安全合并同分片——callee 必在更低层=更早分片已译完。 */
  unitLevels: Record<string, number>
}

// ── 读 subprograms/*.json ──────────────────────────────────────────────────────

function readSubprograms(artifactsDir: string): SubprogramFile[] {
  const dir = join(artifactsDir, "subprograms")
  if (!existsSync(dir)) return []
  const out: SubprogramFile[] = []
  // .sort() 保证读取序确定（translationOrder/procedureOrder 等输出可复现）；
  // refName 已由 refNameOf(overloadIndex) 顺序无关地计算，sort 仅为确定性。
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), "utf-8")) as SubprogramFile)
    } catch (e: any) {
      // 旧 dependency-graph.json 整文件 Zod 校验会硬失败；现在逐文件解析，损坏文件需显式告警，
      // 否则该子程序的 directCalls 静默丢失，callGraph 缺边只在后续 review/verify 间接暴露。
      getLogger().warn("[dependency-graph]", `subprograms/${f} 解析失败，已跳过: ${e?.message ?? e}`)
    }
  }
  return out
}

/** 读 packages/*.json 取全部包名（含无子程序的常量包等，作为 SCC 节点） */
function readPackageNames(artifactsDir: string): string[] {
  const dir = join(artifactsDir, "packages")
  if (!existsSync(dir)) return []
  const names: string[] = []
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue
    try {
      const p = JSON.parse(readFileSync(join(dir, f), "utf-8")) as { packageName: string }
      if (p.packageName) names.push(p.packageName)
    } catch { /* 跳过 */ }
  }
  return names
}

// ── refIndex 构建 ───────────────────────────────────────────────────────────────

/** 从子程序文件构建 refIndex：PKG → { subprograms, procNameToRefNames } */
function buildRefIndex(subprograms: SubprogramFile[]): Map<string, RefIndexEntry> {
  const byPkg = new Map<string, SubprogramFile[]>()
  for (const s of subprograms) {
    const arr = byPkg.get(s.belongToPackage) ?? []
    arr.push(s)
    byPkg.set(s.belongToPackage, arr)
  }
  const result = new Map<string, RefIndexEntry>()
  for (const [pkg, subs] of byPkg) {
    // refName 直接取每个子程序文件的 overloadIndex（scanner 按源码声明序赋值，落盘进文件名），
    // 顺序无关——与 buildDependencyGraph 的 callGraph caller key（亦 refNameOf）一致。
    // 不用 refNamesForPackage(遇见序)：readdirSync 在 ext4/APFS 上非字典序会使重载 refName 错位。
    const subprogIdx = subs.map((s) => ({
      name: s.name,
      refName: refNameOf(s),
      type: s.type.toLowerCase() === "function" ? "function" as const : "procedure" as const,
    }))
    const procNameToRefNames = new Map<string, string[]>()
    for (const s of subprogIdx) {
      const key = s.name.toUpperCase()
      const arr = procNameToRefNames.get(key) ?? []
      arr.push(s.refName)
      procNameToRefNames.set(key, arr)
    }
    result.set(pkg, { subprograms: subprogIdx, procNameToRefNames })
  }
  return result
}

// ── callee 解析 ────────────────────────────────────────────────────────────────

/** 解析 callee 裸名 → 该包下所有同名 refName（重载多版本） */
function resolveCalleeRefNames(
  calleePkg: string,
  calleeName: string,
  refIndex: Map<string, RefIndexEntry>,
): string[] | null {
  const info = refIndex.get(calleePkg)
  if (!info) return null
  const arr = info.procNameToRefNames.get(calleeName.toUpperCase())
  return arr && arr.length > 0 ? arr : null
}

// ── Tarjan SCC（迁移自 analysis-builder）──────────────────────────────────────

export function tarjanSCC(nodes: string[], edges: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let order = 0
  const sccs: string[][] = []
  function strongconnect(v: string): void {
    index.set(v, order); lowlink.set(v, order); order++
    stack.push(v); onStack.add(v)
    for (const w of edges.get(v) ?? new Set()) {
      if (!index.has(w)) { strongconnect(w); lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!)) }
      else if (onStack.has(w)) { lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!)) }
    }
    if (lowlink.get(v) === index.get(v)) {
      const comp: string[] = []
      let w: string
      do { w = stack.pop()!; onStack.delete(w); comp.push(w) } while (w !== v)
      sccs.push(comp)
    }
  }
  for (const v of nodes) if (!index.has(v)) strongconnect(v)
  return sccs
}

// ── 过程级拓扑序（迁移自 analysis-builder）────────────────────────────────────

export function buildProcedureOrder(
  callGraph: Record<string, string[]>,
  refIndex: Map<string, RefIndexEntry>,
): string[][] {
  // 每个 subprogram（过程或函数）各自独立成 unit（unit id = `${pkg}.${refName}`）。
  // 历史 functionOwnership 折叠已移除——它把 FUNCTION 绑给"属主过程"会制造合成环
  // （B 调 A 的 cargo 函数 F → 单元边 B→A，叠加 A→B 成环），违背"subprogram = 独立翻译单元"。
  const unitList: string[] = []
  for (const [pkg, info] of refIndex) {
    for (const s of info.subprograms) unitList.push(`${pkg}.${s.refName}`)
  }
  const unitSet = new Set(unitList)
  const edges = new Map<string, Set<string>>()
  for (const u of unitList) edges.set(u, new Set())
  for (const [s, callees] of Object.entries(callGraph)) {
    if (!unitSet.has(s)) continue
    for (const t of callees) {
      if (t === s || !unitSet.has(t)) continue
      edges.get(s)!.add(t)
    }
  }
  return tarjanSCC(unitList, edges)
}

// ── 拓扑层级（迁移自 analysis-builder 的层级推导）──────────────────────────────

/**
 * 计算每个 unit 的拓扑层级：在 SCC 收缩后的 condensation DAG 上取"到叶子的最长路径"，
 * 叶子 SCC（无外部出边）= 0，否则 max(后继 SCC 层级) + 1。多 unit SCC 整体取同一层级
 *（成员共享 sccId），作为"超级 unit"原子不拆。
 *
 * 用途：computeShardPlan 按层 antichain 批量。同层 unit 必无 caller→callee 边
 *  （若 u→v 则 level(v) ≥ level(u)+1，不可能同层）→ 同层 = antichain → 可安全合并同分片。
 *  condensation 是 DAG（SCC 已收缩），最长路径可记忆化递归，无环终止。
 */
export function computeUnitLevels(
  procedureOrder: string[][],
  callGraph: Record<string, string[]>,
): Record<string, number> {
  // sccId per unit（procedureOrder 每个内层就是一个 SCC）
  const sccId = new Map<string, number>()
  procedureOrder.forEach((layer, i) => {
    if (!layer) return
    for (const u of layer) sccId.set(u, i)
  })
  const sccCount = procedureOrder.length
  // condensation 外部出边（scc → set of scc），排除自环（SVN 内部边不进 condensation）
  const out = new Map<number, Set<number>>()
  for (let i = 0; i < sccCount; i++) out.set(i, new Set())
  for (const [u, callees] of Object.entries(callGraph)) {
    const su = sccId.get(u)
    if (su === undefined) continue
    for (const v of callees) {
      const sv = sccId.get(v)
      if (sv === undefined || sv === su) continue
      out.get(su)!.add(sv)
    }
  }
  // 记忆化最长路径（DAG，无环）
  const cache = new Map<number, number>()
  const levelOfScc = (s: number): number => {
    const c = cache.get(s)
    if (c !== undefined) return c
    const succ = out.get(s)
    let lv = 0
    if (succ && succ.size > 0) {
      let mx = -1
      for (const t of succ) { const lt = levelOfScc(t); if (lt > mx) mx = lt }
      lv = mx + 1
    }
    cache.set(s, lv)
    return lv
  }
  const unitLevels: Record<string, number> = {}
  for (let i = 0; i < sccCount; i++) {
    const layer = procedureOrder[i]
    if (!layer) continue
    const lv = levelOfScc(i)
    for (const u of layer) unitLevels[u] = lv
  }
  return unitLevels
}

// ── 主构建：从 subprograms/*.json directCalls 推导全图 ──────────────────────────

const cache = new Map<string, DependencyGraph>()

/**
 * 构建（并缓存）依赖图：读 subprograms/*.json 的 directCalls → callGraph + packageDependency +
 * Tarjan SCC 翻译序 + 过程级拓扑序。同一 artifactsDir 只构建一次。
 */
export function buildDependencyGraph(artifactsDir: string): DependencyGraph {
  const cached = cache.get(artifactsDir)
  if (cached) return cached

  const subprograms = readSubprograms(artifactsDir)
  const refIndex = buildRefIndex(subprograms)

  // callGraph：caller `PKG.refName` → callee `PKG.refName`[]（重载 callee 展开为多边，去重）
  const callGraph: Record<string, string[]> = {}
  const packageDepsRaw: { callerPkg: string; calleePkg: string }[] = []
  for (const s of subprograms) {
    const info = refIndex.get(s.belongToPackage)
    if (!info) continue
    // 子程序文件本身可能因重载有多个 refName 槽位；按名+overloadIndex 定位当前 refName
    const callerRef = refNameOf(s)
    const callerKey = `${s.belongToPackage}.${callerRef}`
    const arr = callGraph[callerKey] ?? []
    for (const c of s.directCalls) {
      const calleeRefs = resolveCalleeRefNames(c.package, c.name, refIndex)
      if (!calleeRefs) continue  // 非本项目子程序（应已在 scanner 后过滤，双保险）
      if (c.package !== s.belongToPackage) {
        packageDepsRaw.push({ callerPkg: s.belongToPackage, calleePkg: c.package })
      }
      for (const r of calleeRefs) {
        const calleeKey = `${c.package}.${r}`
        if (calleeKey === callerKey) continue  // 自环
        if (!arr.includes(calleeKey)) arr.push(calleeKey)
      }
    }
    if (arr.length > 0) callGraph[callerKey] = arr
  }

  // packageRefs 聚合进 packageDependency（不进 callGraph）——仅常量/类型被引用的跨包边，
  // 使 scope-computer 闭包能纳入 const-only 包。caller/callee 不同包才记边（自环由后续去重兜底）。
  for (const s of subprograms) {
    for (const r of s.packageRefs ?? []) {
      if (r.package !== s.belongToPackage) {
        packageDepsRaw.push({ callerPkg: s.belongToPackage, calleePkg: r.package })
      }
    }
  }

  // packageDependency：跨包引用聚合（排除自环，去重）
  const packageNames = readPackageNames(artifactsDir)
  const packageDependency: Record<string, string[]> = {}
  for (const p of packageNames) packageDependency[p] = []
  for (const { callerPkg, calleePkg } of packageDepsRaw) {
    if (callerPkg === calleePkg) continue
    const arr = packageDependency[callerPkg] ?? (packageDependency[callerPkg] = [])
    if (!arr.includes(calleePkg)) arr.push(calleePkg)
  }

  // 包级 Tarjan SCC → translationOrder（依赖在前）+ sccGroups（size>1）
  const nodes = packageNames
  const edges = new Map<string, Set<string>>()
  for (const p of packageNames) edges.set(p, new Set(packageDependency[p] ?? []))
  const sccs = tarjanSCC(nodes, edges)
  const translationOrder: string[][] = sccs.map(c => c)
  const sccGroups: string[][] = sccs.filter(c => c.length > 1).map(c => [...c].sort())

  // 过程级：每个 subprogram 独立成 unit（见 buildProcedureOrder）。
  const procedureOrder = buildProcedureOrder(callGraph, refIndex)

  // unit id → body 源码行数（供 computeShardPlan 按行数预算切分）。
  const unitLines: Record<string, number> = {}
  for (const s of subprograms) {
    const lr = s.bodyLocation?.lineRange
    const lines = Array.isArray(lr) && lr.length === 2 ? Math.max(0, Number(lr[1]) - Number(lr[0]) + 1) : 0
    unitLines[`${s.belongToPackage}.${refNameOf(s)}`] = lines
  }

  // unit id → 拓扑层级（供 computeShardPlan 按层 antichain 批量）。
  const unitLevels = computeUnitLevels(procedureOrder, callGraph)

  const graph: DependencyGraph = {
    callGraph, packageDependency, packageNames, refIndex,
    translationOrder, sccGroups, procedureOrder, unitLines, unitLevels,
  }
  cache.set(artifactsDir, graph)
  return graph
}

// ── 闭包 ───────────────────────────────────────────────────────────────────────

/** 正向 BFS 闭包：从 entry（`PKG.refName`）出发，沿 callGraph 边收集所有可达子程序（含 entry） */
export function computeClosure(entry: string, callGraph: Record<string, string[]>): Set<string> {
  const seen = new Set<string>([entry])
  const queue: string[] = [entry]
  let head = 0
  while (head < queue.length) {
    const cur = queue[head++]
    for (const next of callGraph[cur] ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next) }
    }
  }
  return seen
}

/** 清缓存（测试/重算用） */
export function clearDependencyGraphCache(artifactsDir?: string): void {
  if (artifactsDir) cache.delete(artifactsDir)
  else cache.clear()
}
