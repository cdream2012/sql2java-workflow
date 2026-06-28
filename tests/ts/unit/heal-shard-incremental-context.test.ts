/**
 * healShardIncrementalContext.test.ts — 分片 incrementalContext 自愈逻辑回归测试
 *
 * bug：历史脏 run（旧代码 a5b84ea4 前）在 unitMode=true 时把 entry 的 incrementalContext 写成
 *   targetPackages（整包名）而非 targetUnits（单 unit id）。worker 据此处理整包 → 越界 + advance
 *   串行锁卡死。healShardIncrementalContext 检测缺/错 targetUnits 并按 shards[shardIndex] 补写。
 */
import { describe, it, expect } from "vitest"
import { healShardIncrementalContext } from "@plugins/workflow-engine"

const SHARD_PLAN = {
  phase: "translate",
  unitMode: true,
  shards: [
    ["CORE_PKG.get_item"],
    ["CORE_PKG.get_item_obj"],
    ["CORE_PKG.bom_cost"],
  ],
  completedShards: [],
}

describe("healShardIncrementalContext", () => {
  it("unitMode + entry 只有脏 targetPackages（缺 targetUnits）→ 补 targetUnits", () => {
    const entry = { incrementalContext: { targetPackages: ["CORE_PKG"], shardIndex: 1, totalShards: 3 } }
    const healed = healShardIncrementalContext(entry, SHARD_PLAN)
    expect(healed).toEqual({
      targetUnits: ["CORE_PKG.get_item_obj"],
      shardIndex: 1,
      totalShards: 3,
    })
  })

  it("unitMode + entry targetUnits 已正确 → null（无需自愈）", () => {
    const entry = { incrementalContext: { targetUnits: ["CORE_PKG.get_item_obj"], shardIndex: 1, totalShards: 3 } }
    expect(healShardIncrementalContext(entry, SHARD_PLAN)).toBeNull()
  })

  it("unitMode + entry targetUnits 与 shards[shardIndex] 不符 → 补正", () => {
    const entry = { incrementalContext: { targetUnits: ["WRONG.unit"], shardIndex: 2, totalShards: 3 } }
    expect(healShardIncrementalContext(entry, SHARD_PLAN)).toEqual({
      targetUnits: ["CORE_PKG.bom_cost"],
      shardIndex: 2,
      totalShards: 3,
    })
  })

  it("unitMode + entry 无 incrementalContext → 按 shardIndex 0 补", () => {
    const entry = { incrementalContext: { shardIndex: 0, totalShards: 3 } }
    expect(healShardIncrementalContext(entry, SHARD_PLAN)).toEqual({
      targetUnits: ["CORE_PKG.get_item"],
      shardIndex: 0,
      totalShards: 3,
    })
  })

  it("包级 shardPlan（unitMode=false）→ null（targetPackages 合法，不应自愈）", () => {
    const pkgPlan = { ...SHARD_PLAN, unitMode: false }
    const entry = { incrementalContext: { targetPackages: ["CORE_PKG"], shardIndex: 0, totalShards: 3 } }
    expect(healShardIncrementalContext(entry, pkgPlan)).toBeNull()
  })

  it("shardPlan=null / currentEntry=null → null", () => {
    expect(healShardIncrementalContext({ incrementalContext: {} }, null)).toBeNull()
    expect(healShardIncrementalContext(null, SHARD_PLAN)).toBeNull()
  })

  it("shardIndex 越界（shards[si] 不存在）→ null（不臆造）", () => {
    const entry = { incrementalContext: { targetPackages: ["CORE_PKG"], shardIndex: 99, totalShards: 3 } }
    expect(healShardIncrementalContext(entry, SHARD_PLAN)).toBeNull()
  })
})
