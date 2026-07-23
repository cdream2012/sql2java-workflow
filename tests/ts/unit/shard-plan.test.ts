/**
 * shard-plan.test.ts — computeShardPlan 切分策略单元测试
 *
 * 锁定关键不变量：
 * 1. SCC 组（length > 1 的层）原子不可分——绝不拆到不同分片
 * 2. 叶子 unit（callGraph 无出边）前置批量打包，非叶子 1/shard
 */

import { describe, it, expect } from "vitest"
import { WorkflowEngine } from "@workflow/engine-core"

function plan(order: string[][]) {
  const engine = new WorkflowEngine()
  // computeShardPlan 是纯函数（不依赖实例状态），直接调用
  return (engine as any).computeShardPlan(order, "translate")
}

function shardsFor(order: string[][], phase: string) {
  const engine = new WorkflowEngine()
  const eff = (engine as any).shardOrderForPhase(order, phase)
  return (engine as any).computeShardPlan(eff, phase).shards as string[][]
}

describe("computeShardPlan", () => {
  it("SCC 组整组一个分片（不可拆）", () => {
    // 5 unit SCC 组 → 整组一个分片
    const order = [["A", "B", "C", "D", "E"]]
    expect(plan(order).shards).toEqual([["A", "B", "C", "D", "E"]])
  })

  it("多个 SCC 组各整组一个分片", () => {
    const order = [["A", "B"], ["X", "Y", "Z"]]
    expect(plan(order).shards).toEqual([["A", "B"], ["X", "Y", "Z"]])
  })

  it("空层被跳过", () => {
    const order = [["A"], [], ["B"]]
    expect(plan(order).shards).toEqual([["A"], ["B"]])
  })

  it("无 levelOf 时所有 unit 1/shard（缺省不跨层合并）", () => {
    const order = [["A"], ["B"], ["C"]]
    expect(plan(order).shards).toEqual([["A"], ["B"], ["C"]])
  })
})

describe("computeShardPlan 按层 antichain 批量（传 levelOf）", () => {
  function planLevel(
    order: string[][],
    levelOf: (u: string) => number,
    opts?: { maxUnitsPerShard?: number; maxLinesPerShard?: number; sizeOf?: (u: string) => number },
  ) {
    const engine = new WorkflowEngine()
    return (engine as any).computeShardPlan(order, "translate", {
      levelOf, ...(opts ?? {}),
    }).shards as string[][]
  }

  it("同层 unit 按 maxUnits 批量打包", () => {
    // 5 个全 level 0（叶子），cap=2 → [L1,L2],[L3,L4],[L5]
    const order = [["L1"], ["L2"], ["L3"], ["L4"], ["L5"]]
    const levelOf = () => 0
    expect(planLevel(order, levelOf, { maxUnitsPerShard: 2 })).toEqual([["L1", "L2"], ["L3", "L4"], ["L5"]])
  })

  it("同层批量，不同层按层序分开（低层在前）", () => {
    // L1,L2,L3,L4 = level 0；N1 = level 1（调叶子）。cap=2
    // L0 批量 [L1,L2],[L3,L4]；L1 的 N1 独立在后
    const order = [["L1"], ["L2"], ["N1"], ["L3"], ["L4"]]
    const levelOf = (u: string) => (u.startsWith("L") ? 0 : 1)
    expect(planLevel(order, levelOf, { maxUnitsPerShard: 2 })).toEqual([["L1", "L2"], ["L3", "L4"], ["N1"]])
  })

  it("多 unit SCC 原子不拆（作为整体 item 落在成员最高层）", () => {
    // [A,B] 互依赖 SCC 调叶子 → level 1；L1/L2 叶子 → level 0。cap=2
    // L0: [L1,L2]；L1: [A,B]（原子，count 2 = cap 但不可拆 → 独占一片）
    const order = [["L1"], ["A", "B"], ["L2"]]
    const levelOf = (u: string) => (u === "A" || u === "B" ? 1 : 0)
    expect(planLevel(order, levelOf, { maxUnitsPerShard: 2 })).toEqual([["L1", "L2"], ["A", "B"]])
  })

  it("层序：低层全部在前，高层在后（callee 必在更早分片）", () => {
    // L*=level0, N1=level1, N2=level2。cap=2
    const order = [["L1"], ["L2"], ["N1"], ["L3"], ["N2"], ["L4"], ["L5"]]
    const levelOf = (u: string) => (u.startsWith("L") ? 0 : u === "N1" ? 1 : 2)
    const shards = planLevel(order, levelOf, { maxUnitsPerShard: 2 })
    expect(shards).toEqual([["L1", "L2"], ["L3", "L4"], ["L5"], ["N1"], ["N2"]])
    const flat = shards.flat()
    // 所有 level0 在 level1/2 之前；level1 在 level2 之前
    for (const l of ["L1", "L2", "L3", "L4", "L5"]) {
      expect(flat.indexOf(l)).toBeLessThan(flat.indexOf("N1"))
      expect(flat.indexOf(l)).toBeLessThan(flat.indexOf("N2"))
    }
    expect(flat.indexOf("N1")).toBeLessThan(flat.indexOf("N2"))
  })

  it("同片无 caller→callee 边（antichain 安全不变量）", () => {
    // a→b, a→c, b→c：c=L0, b=L1, a=L2，三层各一片，无同片边
    const order = [["a"], ["b"], ["c"]]
    const callGraph: Record<string, string[]> = { a: ["b", "c"], b: ["c"] }
    const levelOf = (u: string) => ({ c: 0, b: 1, a: 2 } as Record<string, number>)[u]
    const shards = planLevel(order, levelOf)
    expect(shards).toEqual([["c"], ["b"], ["a"]])
    // 每条 caller→callee 边的两端必在不同分片
    for (const [u, vs] of Object.entries(callGraph)) {
      for (const v of vs) {
        const si = shards.findIndex(s => s.includes(u))
        const sj = shards.findIndex(s => s.includes(v))
        expect(si).not.toBe(sj)
      }
    }
  })

  it("同层兄弟非叶子合并（POST_TXN 式：三者同调一叶子、互不调用）", () => {
    // PKG_A.z = level 0（叶子）；PKG_A.a/b/c 都调 z、互不调用 → 同 level 1 → 合并 1 片
    const order = [["PKG_A.z"], ["PKG_A.a"], ["PKG_A.b"], ["PKG_A.c"]]
    const levelOf = (u: string) => (u === "PKG_A.z" ? 0 : 1)
    expect(planLevel(order, levelOf, { maxUnitsPerShard: 16 })).toEqual([
      ["PKG_A.z"],
      ["PKG_A.a", "PKG_A.b", "PKG_A.c"],
    ])
  })

  it("叶子（L0）不与非叶子（L1+）同分片", () => {
    // 叶子必 level 0，非叶子 level ≥1 → 不同层不同片
    const order = [["L1"], ["L2"], ["N1"], ["L3"]]
    const levelOf = (u: string) => (u.startsWith("L") ? 0 : 1)
    const shards = planLevel(order, levelOf, { maxUnitsPerShard: 8 })
    for (const shard of shards) {
      const hasLeaf = shard.some(u => u.startsWith("L"))
      const hasNonLeaf = shard.some(u => !u.startsWith("L"))
      expect(hasLeaf && hasNonLeaf).toBe(false)
    }
  })

  it("cap=8：8 个同层 unit 一个分片", () => {
    const order = Array.from({ length: 8 }, (_, i) => [`L${i + 1}`])
    const levelOf = () => 0
    expect(planLevel(order, levelOf, { maxUnitsPerShard: 8 })).toEqual([order.flat()])
  })

  it("cap=0/负数：兜底为 1，不死循环、不丢 unit", () => {
    const order = [["L1"], ["L2"], ["L3"]]
    const levelOf = () => 0
    expect(planLevel(order, levelOf, { maxUnitsPerShard: 0 })).toEqual([["L1"], ["L2"], ["L3"]])
    expect(planLevel(order, levelOf, { maxUnitsPerShard: -3 })).toEqual([["L1"], ["L2"], ["L3"]])
  })

  it("同包优先：同 package 同层 unit 聚到同分片", () => {
    // PKG_A 两 unit + PKG_B 两 unit，全 level 0，cap=4 → 按包排序聚一起
    const order = [["PKG_B.b1"], ["PKG_A.a1"], ["PKG_B.b2"], ["PKG_A.a2"]]
    const levelOf = () => 0
    expect(planLevel(order, levelOf, { maxUnitsPerShard: 4 })).toEqual([
      ["PKG_A.a1", "PKG_A.a2", "PKG_B.b1", "PKG_B.b2"],
    ])
  })

  it("行数预算：大 unit 触发 flush，且 ≥1 保证其独占一片（不孤立不拆）", () => {
    // PKG_A.a1/a2=10 行，PKG_A.zbig=5000 行（超 maxLines=3000），全 level 0
    const order = [["PKG_A.a1"], ["PKG_A.a2"], ["PKG_A.zbig"]]
    const levelOf = () => 0
    const sizeOf = (u: string) => (u === "PKG_A.zbig" ? 5000 : 10)
    const shards = planLevel(order, levelOf, { maxLinesPerShard: 3000, maxUnitsPerShard: 16, sizeOf })
    expect(shards).toEqual([["PKG_A.a1", "PKG_A.a2"], ["PKG_A.zbig"]])
  })

  it("个数兜底：海量同层小 unit 按 maxUnits 切（行数不触发）", () => {
    const order = Array.from({ length: 10 }, (_, i) => [`PKG_A.l${String(i + 1).padStart(2, "0")}`])
    const levelOf = () => 0
    const sizeOf = () => 1
    const shards = planLevel(order, levelOf, { maxLinesPerShard: 3000, maxUnitsPerShard: 4, sizeOf })
    expect(shards.length).toBe(3)
    expect(shards.every(s => s.length <= 4)).toBe(true)
    expect(shards.flat().length).toBe(10)
  })

  it("analyze 与 translate 分片完全一致（按层批量 + SCC 混合，传 levelOf/sizeOf）", () => {
    // 2 叶子（level 0）+ 2-unit SCC（调叶子 → level 1）+ 非叶子（调叶子 → level 1）
    const order = [
      ["PKG_A.leaf1"], ["PKG_A.leaf2"],
      ["PKG_B.a", "PKG_B.b"],  // SCC 组
      ["PKG_C.caller"],
    ]
    const levelOf = (u: string) => (u.startsWith("PKG_A.") ? 0 : 1)
    const sizeOf = (u: string) => (u.endsWith("leaf1") ? 10 : u.endsWith("leaf2") ? 20 : 100)
    const engine = new WorkflowEngine()
    const opts = { levelOf, sizeOf, maxLinesPerShard: 3000, maxUnitsPerShard: 16 }
    const analyzeShards = (engine as any).computeShardPlan(order, "analyze", opts).shards as string[][]
    const translateShards = (engine as any).computeShardPlan(order, "translate", opts).shards as string[][]
    expect(analyzeShards).toEqual(translateShards)
    // L0: [leaf1,leaf2]；L1: SCC [a,b] 原子 + caller —— 同层可共片（互无 caller→callee 边）
    expect(analyzeShards).toEqual([
      ["PKG_A.leaf1", "PKG_A.leaf2"],
      ["PKG_B.a", "PKG_B.b", "PKG_C.caller"],
    ])
    // 逐 unit 核对：每个 unit 在两阶段的分片号相同
    for (const u of order.flat()) {
      const ai = analyzeShards.findIndex(s => s.includes(u))
      const ti = translateShards.findIndex(s => s.includes(u))
      expect(ai).toBe(ti)
      expect(ai).toBeGreaterThanOrEqual(0)
    }
  })
})

describe("shardOrderForPhase（analyze/translate 保留 SCC，review 拍平）", () => {
  // 含一个 5 包 SCC 组 + 一个 2 包 SCC 组 + 若干独立包（取自真实 13 包项目 translationOrder）
  const order = [
    ["CONST"], ["UTIL"],
    ["ITEM", "BOM", "PRICING", "FORECAST", "REPORT"],
    ["INVENTORY"],
    ["COSTING", "PROCUREMENT"],
    ["MRP"],
  ]
  const multiExpected = [
    ["ITEM", "BOM", "PRICING", "FORECAST", "REPORT"],
    ["COSTING", "PROCUREMENT"],
  ]

  it("analyze: 保留 SCC 共处 → 与 translate 完全一致（便于追踪）", () => {
    const shards = shardsFor(order, "analyze")
    const multi = shards.filter(s => s.length > 1)
    expect(multi).toEqual(multiExpected)
    expect(shards).toEqual(shardsFor(order, "translate"))
  })

  it("review: 拍平 SCC → 每包一个分片，0 多包分片", () => {
    const shards = shardsFor(order, "review")
    expect(shards.length).toBe(11)
    expect(shards.every(s => s.length === 1)).toBe(true)
    expect(shards.flat()).toEqual(order.flat())
  })

  it("translate: 保留 SCC 共处 → 2 个多包分片（5 包组 + 2 包组）", () => {
    const shards = shardsFor(order, "translate")
    const multi = shards.filter(s => s.length > 1)
    expect(multi).toEqual(multiExpected)
  })
})

describe("shardOrderForPhase（analyze PROCEDURE 级：保留 SCC）", () => {
  // analyze 下沉到 PROCEDURE 级后，dispatch 传入 procedureOrder（unit id `PKG.refName`）。
  // analyze 与 translate 同策略：SCC 组内 unit 共处同一分片（artifact 仍 per-unit：fsd/{pkg}/{ref}.md）。
  const unitOrder = [
    ["PKG_A.p1"],
    ["PKG_A.p2", "PKG_A.p3"], // 同包 SCC 组（互递归 unit）
    ["PKG_B.q1"],
  ]

  it("analyze: unit 级保留 SCC → SCC 组内 unit 不拆，与 translate 一致", () => {
    const shards = shardsFor(unitOrder, "analyze")
    expect(shards).toEqual([["PKG_A.p1"], ["PKG_A.p2", "PKG_A.p3"], ["PKG_B.q1"]])
    expect(shards).toEqual(shardsFor(unitOrder, "translate"))
  })
})
