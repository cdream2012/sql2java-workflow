/**
 * analysis-builder.test.ts — analyze reduce（代码）核心逻辑测试
 *
 * 新形状：buildDependencyGraphFromIndex 仅做 complexity（写入 packages/{PKG}.json）+ 无子程序包空
 * analysis-packages 兜底；调用图（callGraph/packageDependency/translationOrder/sccGroups/procedureOrder）
 * 由 dependency-graph.ts 从 subprograms.directCalls 按需推导（buildDependencyGraph）。
 *
 * 覆盖：① tiny fixture 上 complexity/backstop 产出 + buildDependencyGraph 推导；② Tarjan SCC（含环）；
 * ③ 单元级 procedureOrder（subprogram 独立成 unit，含合成环消除）；④ 合成 fixture 跨包调用。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { scanSource } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import { buildDependencyGraphFromIndex } from "@workflow/analysis-builder"
import {
  buildDependencyGraph, tarjanSCC, buildProcedureOrder, computeUnitLevels,
  type RefIndexEntry,
} from "@workflow/dependency-graph"
import { AnalysisPackageSchema } from "@workflow/artifact-schemas"
import { refNamesForPackage } from "@workflow/refname"

const FIXTURE_TINY = resolve(import.meta.dirname, "../fixtures/sql/tiny")
let dir: string

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "analysis-build-"))
  const index = await scanSource(FIXTURE_TINY)
  mkdirSync(dir, { recursive: true })
  buildInventoryFromIndex(dir, index)
  buildDependencyGraphFromIndex(dir)
}, 60000)

describe("buildDependencyGraphFromIndex (tiny fixture)", () => {
  it("complexity 写入 packages/{PKG}.json：CORE_PKG high + 模式，BASE_PKG low", () => {
    const core = JSON.parse(readFileSync(join(dir, "packages", "CORE_PKG.json"), "utf-8"))
    expect(core.complexity.riskLevel).toBe("high")
    expect(core.complexity.score).toBe(10) // clamp 上限
    const pats = core.complexity.patterns
    expect(pats).toContain("dynamic-sql")
    expect(pats).toContain("bulk-collect")
    expect(pats).toContain("connect-by")
    expect(pats).toContain("pipelined")

    const base = JSON.parse(readFileSync(join(dir, "packages", "BASE_PKG.json"), "utf-8"))
    expect(base.complexity.riskLevel).toBe("low")
    expect(base.complexity.score).toBeLessThanOrEqual(3)
  })

  it("无子程序包写空 analysis-packages/{PKG}.json（过 AnalysisPackageSchema）", () => {
    const base = JSON.parse(readFileSync(join(dir, "analysis-packages", "BASE_PKG.json"), "utf-8"))
    expect(base).toEqual({ packageName: "BASE_PKG", subprograms: [] })
    expect(AnalysisPackageSchema.safeParse(base).success).toBe(true)
    // 有子程序的包此处不写（由 analyze map 阶段填充）
    expect(existsSync(join(dir, "analysis-packages", "CORE_PKG.json"))).toBe(false)
  })
})

describe("buildDependencyGraph (tiny fixture)", () => {
  it("packageNames 覆盖全部包", () => {
    const g = buildDependencyGraph(dir)
    // 含独立函数 fn_abc_class 注入的虚拟包
    expect(g.packageNames.sort()).toEqual(["BASE_PKG", "CORE_PKG", "__STANDALONE_FN_ABC_CLASS__"])
  })

  it("callGraph 捕获同包函数调用 GET_ITEM_OBJ→GET_ITEM（自递归 bom_cost 排除）", () => {
    const g = buildDependencyGraph(dir)
    // get_item_obj 调 get_item（同包裸名函数调用，经 general_element 捕获）
    expect(g.callGraph["CORE_PKG.GET_ITEM_OBJ"]).toContain("CORE_PKG.GET_ITEM")
    // bom_cost 自递归按 plan「调用方自身（递归）排除」不进 callGraph
    expect(g.callGraph["CORE_PKG.BOM_COST"]).toBeUndefined()
  })

  it("translationOrder 含所有包；sccGroups 无环时为空", () => {
    const g = buildDependencyGraph(dir)
    const order = g.translationOrder.flat()
    expect(order).toEqual(expect.arrayContaining(["BASE_PKG", "CORE_PKG", "__STANDALONE_FN_ABC_CLASS__"]))
    expect(g.sccGroups).toEqual([])
  })
})

// ── Tarjan SCC ──────────────────────────────────────────────────────────────

describe("tarjanSCC", () => {
  it("无环：依赖在前拓扑序", () => {
    const nodes = ["A", "B", "C"]
    const edges = new Map([["A", new Set(["B"])], ["B", new Set()], ["C", new Set(["B"])]])
    const sccs = tarjanSCC(nodes, edges)
    expect(sccs[0]).toEqual(["B"])
    expect(sccs.slice(1).map(c => c[0]).sort()).toEqual(["A", "C"])
    expect(sccs.every(c => c.length === 1)).toBe(true)
  })

  it("有环：SCC 组归为同组，且组内成员一起", () => {
    const nodes = ["A", "B", "C"]
    const edges = new Map([
      ["A", new Set(["B"])],
      ["B", new Set(["A", "C"])],
      ["C", new Set()],
    ])
    const sccs = tarjanSCC(nodes, edges)
    const cyclic = sccs.find(c => c.length > 1)!
    expect(cyclic.sort()).toEqual(["A", "B"])
    expect(sccs.find(c => c.length === 1 && c[0] === "C")).toBeTruthy()
    const cIdx = sccs.findIndex(c => c.includes("C"))
    const abIdx = sccs.findIndex(c => c.length > 1)
    expect(cIdx).toBeLessThan(abIdx)
  })

  it("自环不构成多元素 SCC", () => {
    const nodes = ["A"]
    const edges = new Map([["A", new Set(["A"])]])
    const sccs = tarjanSCC(nodes, edges)
    expect(sccs).toEqual([["A"]])
  })
})

// ── refIndex 构造辅助 + 单元级 procedureOrder ──────────

/** 从 {name, procs:[{name,type}]} 构造 refIndex（复用 refNamesForPackage 推导重载 refName） */
function makeRefIndex(pkgs: { name: string; procs: { name: string; type: "procedure" | "function" }[] }[]): Map<string, RefIndexEntry> {
  const m = new Map<string, RefIndexEntry>()
  for (const p of pkgs) {
    const names = p.procs.map(c => c.name)
    const refNames = refNamesForPackage(names)
    const subprograms = p.procs.map((c, i) => ({ name: c.name, refName: refNames[i], type: c.type }))
    const procNameToRefNames = new Map<string, string[]>()
    for (const s of subprograms) {
      const k = s.name.toUpperCase()
      const arr = procNameToRefNames.get(k) ?? []
      arr.push(s.refName)
      procNameToRefNames.set(k, arr)
    }
    m.set(p.name, { subprograms, procNameToRefNames })
  }
  return m
}

describe("refName 索引（重载）", () => {
  it("非重载→裸名；重载→{name}__{i}（1-based，全部带序号）", () => {
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "get_param", type: "procedure" },
      { name: "get_param", type: "procedure" },
      { name: "unique_fn", type: "function" },
    ] }])
    const info = ref.get("P")!
    expect(info.subprograms.map(s => s.refName)).toEqual(["get_param__1", "get_param__2", "unique_fn"])
    expect(info.procNameToRefNames.get("GET_PARAM")).toEqual(["get_param__1", "get_param__2"])
    expect(info.procNameToRefNames.get("UNIQUE_FN")).toEqual(["unique_fn"])
  })
})

describe("buildProcedureOrder（单元级拓扑序）", () => {
  it("FUNCTION 独立成 unit（不再折叠进 owner），叶子在前", () => {
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "p1", type: "procedure" }, { name: "f1", type: "function" },
    ] }])
    const order = buildProcedureOrder({ "P.p1": ["P.f1"] }, ref)
    // f1 是叶子（无出边），p1 调 f1 → f1 在前、p1 在后；两者各自独立成 unit
    expect(order.flat()).toEqual(["P.f1", "P.p1"])
  })

  it("孤儿 FUNCTION 独立成 unit", () => {
    const ref = makeRefIndex([{ name: "P", procs: [{ name: "f1", type: "function" }] }])
    const order = buildProcedureOrder({}, ref)
    expect(order.flat()).toEqual(["P.f1"])
  })

  it("跨包调用：被依赖 unit 在前", () => {
    const ref = makeRefIndex([
      { name: "P", procs: [{ name: "f1", type: "function" }] },
      { name: "Q", procs: [{ name: "q1", type: "procedure" }] },
    ])
    const order = buildProcedureOrder({ "Q.q1": ["P.f1"] }, ref).flat()
    expect(order.indexOf("P.f1")).toBeLessThan(order.indexOf("Q.q1"))
  })

  it("单元间 SCC（互调用 proc）归同层", () => {
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "p1", type: "procedure" }, { name: "p2", type: "procedure" },
    ] }])
    const order = buildProcedureOrder({ "P.p1": ["P.p2"], "P.p2": ["P.p1"] }, ref)
    expect(order.length).toBe(1)
    expect(order[0].sort()).toEqual(["P.p1", "P.p2"])
  })

  it("合成环消除：B 调 A 的 cargo 函数 F 不再造 A↔B 环（F 独立成叶子 unit）", () => {
    // 旧属主折叠会把 F 判给 A → B→A（经 F 属主）+ A→B = 环。
    // F 独立后：A→B、B→F，DAG 无环；F 叶子在前。
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "A", type: "procedure" }, { name: "B", type: "procedure" },
      { name: "F", type: "function" },
    ] }])
    const order = buildProcedureOrder({ "P.A": ["P.B"], "P.B": ["P.F"] }, ref)
    expect(order.length).toBe(3) // 三个独立 unit，无 SCC
    const flat = order.flat()
    expect(flat.indexOf("P.F")).toBeLessThan(flat.indexOf("P.B"))
    expect(flat.indexOf("P.B")).toBeLessThan(flat.indexOf("P.A"))
  })
})

describe("computeUnitLevels（拓扑层级 = 到叶子最长路径）", () => {
  it("叶子=0，caller=叶子层级+1", () => {
    // f1 叶子；p1 调 f1 → f1=0, p1=1
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "p1", type: "procedure" }, { name: "f1", type: "function" },
    ] }])
    const order = buildProcedureOrder({ "P.p1": ["P.f1"] }, ref)
    const levels = computeUnitLevels(order, { "P.p1": ["P.f1"] })
    expect(levels["P.f1"]).toBe(0)
    expect(levels["P.p1"]).toBe(1)
  })

  it("深调用链：每层 +1", () => {
    // F ← B ← A（A→B→F）：F=0, B=1, A=2
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "A", type: "procedure" }, { name: "B", type: "procedure" },
      { name: "F", type: "function" },
    ] }])
    const cg = { "P.A": ["P.B"], "P.B": ["P.F"] }
    const order = buildProcedureOrder(cg, ref)
    const levels = computeUnitLevels(order, cg)
    expect(levels["P.F"]).toBe(0)
    expect(levels["P.B"]).toBe(1)
    expect(levels["P.A"]).toBe(2)
  })

  it("共享 callee + 链上：a→b,a→c,b→c → c=0,b=1,a=2", () => {
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "a", type: "procedure" }, { name: "b", type: "procedure" },
      { name: "c", type: "procedure" },
    ] }])
    const cg = { "P.a": ["P.b", "P.c"], "P.b": ["P.c"] }
    const order = buildProcedureOrder(cg, ref)
    const levels = computeUnitLevels(order, cg)
    expect(levels["P.c"]).toBe(0)
    expect(levels["P.b"]).toBe(1)
    expect(levels["P.a"]).toBe(2)
  })

  it("同层兄弟：三者同调一叶子、互不调用 → 同 level 1", () => {
    // z=叶子；a/b/c 都调 z、互不调用 → z=0, a/b/c=1
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "z", type: "function" }, { name: "a", type: "procedure" },
      { name: "b", type: "procedure" }, { name: "c", type: "procedure" },
    ] }])
    const cg = { "P.a": ["P.z"], "P.b": ["P.z"], "P.c": ["P.z"] }
    const order = buildProcedureOrder(cg, ref)
    const levels = computeUnitLevels(order, cg)
    expect(levels["P.z"]).toBe(0)
    expect(levels["P.a"]).toBe(1)
    expect(levels["P.b"]).toBe(1)
    expect(levels["P.c"]).toBe(1)
  })

  it("多 unit SCC 整体取成员最高层（作为超级 unit）", () => {
    // p1↔p2 互递归 SCC，二者都调 f（叶子）→ SCC level=1（f=0）；p1/p2 同 level
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "p1", type: "procedure" }, { name: "p2", type: "procedure" },
      { name: "f", type: "function" },
    ] }])
    const cg = { "P.p1": ["P.p2", "P.f"], "P.p2": ["P.p1"] }
    const order = buildProcedureOrder(cg, ref)
    const levels = computeUnitLevels(order, cg)
    expect(levels["P.f"]).toBe(0)
    expect(levels["P.p1"]).toBe(1)
    expect(levels["P.p2"]).toBe(1)
  })

  it("同层 = antichain：同层 unit 间无 caller→callee 边", () => {
    // 构造 a→b→c 链 + d→c（d 与 b 同层=1，互不调用）
    const ref = makeRefIndex([{ name: "P", procs: [
      { name: "a", type: "procedure" }, { name: "b", type: "procedure" },
      { name: "c", type: "procedure" }, { name: "d", type: "procedure" },
    ] }])
    const cg = { "P.a": ["P.b"], "P.b": ["P.c"], "P.d": ["P.c"] }
    const order = buildProcedureOrder(cg, ref)
    const levels = computeUnitLevels(order, cg)
    // 同层的 b,d 互不调用（antichain）；任何 u→v 必 level(v)≥level(u)+1
    expect(levels["P.c"]).toBe(0)
    expect(levels["P.b"]).toBe(1)
    expect(levels["P.d"]).toBe(1)
    expect(levels["P.a"]).toBe(2)
    for (const [u, vs] of Object.entries(cg)) {
      for (const v of vs) {
        // u→v：u 是 caller，层级更高（u 到叶子最长路径 ≥ v 的 +1）
        expect(levels[u]).toBeGreaterThanOrEqual(levels[v] + 1)
      }
    }
  })
})

// ── 合成 fixture：真实跨包调用 ──────────────────────────────────────────────

describe("callGraph 真实跨包调用（合成 fixture）", () => {
  let synthDir: string
  let synthArtifacts: string

  async function buildSynth(pkgASpec: string, pkgBSpec: string) {
    synthDir = mkdtempSync(join(tmpdir(), "analysis-synth-"))
    writeFileSync(join(synthDir, "pkg_b.pks"), pkgBSpec, "utf-8")
    writeFileSync(join(synthDir, "pkg_b.pkb"), `
CREATE OR REPLACE PACKAGE BODY pkg_b AS
  PROCEDURE p2(p IN NUMBER) IS BEGIN NULL; END;
END pkg_b;
/
`, "utf-8")
    writeFileSync(join(synthDir, "pkg_a.pks"), `
CREATE OR REPLACE PACKAGE pkg_a AS
  PROCEDURE p1(p IN NUMBER);
END pkg_a;
/
`, "utf-8")
    writeFileSync(join(synthDir, "pkg_a.pkb"), pkgASpec, "utf-8")
    const index = await scanSource(synthDir)
    synthArtifacts = mkdtempSync(join(tmpdir(), "analysis-synth-art-"))
    buildInventoryFromIndex(synthArtifacts, index)
    return buildDependencyGraph(synthArtifacts)
  }

  it("callGraph 捕获跨包子程序调用 PKG_A.p1 → PKG_B.p2", async () => {
    const g = await buildSynth(
      `CREATE OR REPLACE PACKAGE BODY pkg_a AS
  PROCEDURE p1(p IN NUMBER) IS
  BEGIN
    pkg_b.p2(p);
  END;
END pkg_a;
/`,
      `CREATE OR REPLACE PACKAGE pkg_b AS
  PROCEDURE p2(p IN NUMBER);
END pkg_b;
/`,
    )
    expect(g.callGraph["PKG_A.P1"]).toContain("PKG_B.P2")
    expect(g.packageDependency["PKG_A"]).toContain("PKG_B")
    expect(g.packageDependency["PKG_B"]).toEqual([])
    const order = g.translationOrder.flat()
    expect(order.indexOf("PKG_B")).toBeLessThan(order.indexOf("PKG_A"))
  }, 60000)

  it("常量引用不进 callGraph（directCalls 仅捕获调用，非包级引用）", async () => {
    // 新形状：directCalls 仅记录带 function_argument 的调用；裸常量引用 pkg_b.c_const 不进 directCalls，
    // 故 callGraph 无边。包级 packageDependency 也由 directCalls 聚合，常量引用不建边
    //（旧 scanCallSites 捕获所有 PKG.X；新 listener 仅捕获调用——已知限制，const-only 包依赖需另行补）。
    const g = await buildSynth(
      `CREATE OR REPLACE PACKAGE BODY pkg_a AS
  PROCEDURE p1(p IN NUMBER) IS
    v NUMBER;
  BEGIN
    v := pkg_b.c_const;
  END;
END pkg_a;
/`,
      `CREATE OR REPLACE PACKAGE pkg_b AS
  c_const CONSTANT NUMBER := 1;
  PROCEDURE p2(p IN NUMBER);
END pkg_b;
/`,
    )
    expect(g.callGraph["PKG_A.P1"]).toBeUndefined()
  }, 60000)
})
