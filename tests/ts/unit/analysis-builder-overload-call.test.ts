/**
 * analysis-builder-overload-call.test.ts — 包内同名重载裸名调用建边回归
 *
 * 场景：receive_stock 有两个 overload，__2（按编码）裸名委托 __1（按 ID）。
 * 旧 scanner 在 recordCall 按 `method === caller.name` 当自递归丢弃 → callGraph 缺
 * __2→__1 边 → 拓扑层级算反（__2=L3 < __1=L6）→ __2 先于 __1 翻译 → 前向引用 TODO。
 * 修复：scanner 不丢弃同名调用，由 dependency-graph resolveCalleeRefNames 展开同名全部
 * 重载 refName + self-skip 兜住真自递归、保留跨重载边。
 */
import { describe, it, expect, beforeAll } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { scanSource } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import { buildDependencyGraph } from "@workflow/dependency-graph"

let dir: string
let graph: ReturnType<typeof buildDependencyGraph>

const BODY = `CREATE OR REPLACE PACKAGE OVERLOAD_PKG AS
  PROCEDURE receive_stock(ii_item_id NUMBER, ii_warehouse_id NUMBER, ii_qty NUMBER);
  PROCEDURE receive_stock(is_item_code VARCHAR2, is_warehouse_code VARCHAR2, ii_qty NUMBER);
END OVERLOAD_PKG;
/
CREATE OR REPLACE PACKAGE BODY OVERLOAD_PKG AS
  PROCEDURE receive_stock(ii_item_id NUMBER, ii_warehouse_id NUMBER, ii_qty NUMBER) IS
  BEGIN
    NULL;
  END;
  PROCEDURE receive_stock(is_item_code VARCHAR2, is_warehouse_code VARCHAR2, ii_qty NUMBER) IS
    v_item_id NUMBER;
  BEGIN
    -- 委托给 by-ID overload（裸名同名调用，非自递归）
    receive_stock(ii_item_id => v_item_id, ii_warehouse_id => 0, ii_qty => ii_qty);
  END;
END OVERLOAD_PKG;
/
`

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "overload-call-"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "overload_pkg_body.sql"), BODY, "utf-8")
  const index = await scanSource(dir)
  buildInventoryFromIndex(dir, index)
  graph = buildDependencyGraph(dir)
}, 30000)

describe("包内同名重载裸名调用建边", () => {
  it("两个 overload 各自独立成 unit（RECEIVE_STOCK__1 / __2）", () => {
    const units = graph.procedureOrder.flat().sort()
    expect(units).toEqual(["OVERLOAD_PKG.RECEIVE_STOCK__1", "OVERLOAD_PKG.RECEIVE_STOCK__2"])
  })

  it("__2 裸名委托 __2→__1 建边（不再被当自递归丢弃）", () => {
    expect(graph.callGraph["OVERLOAD_PKG.RECEIVE_STOCK__2"]).toContain("OVERLOAD_PKG.RECEIVE_STOCK__1")
  })

  it("__1 无回边到 __2（无幻边成环）", () => {
    const callees = graph.callGraph["OVERLOAD_PKG.RECEIVE_STOCK__1"] ?? []
    expect(callees).not.toContain("OVERLOAD_PKG.RECEIVE_STOCK__2")
  })

  it("无 SCC 膨胀（__1→__2 单向，非强连通）", () => {
    expect(graph.sccGroups).toEqual([])
  })

  it("拓扑层级正确：__1（叶子）在前、__2（caller）在后", () => {
    const flat = graph.procedureOrder.flat()
    expect(flat.indexOf("OVERLOAD_PKG.RECEIVE_STOCK__1")).toBeLessThan(flat.indexOf("OVERLOAD_PKG.RECEIVE_STOCK__2"))
  })

  it("unitLevels：__2 层级 > __1 层级（caller 高于 callee）", () => {
    expect(graph.unitLevels["OVERLOAD_PKG.RECEIVE_STOCK__2"]).toBeGreaterThan(graph.unitLevels["OVERLOAD_PKG.RECEIVE_STOCK__1"])
    expect(graph.unitLevels["OVERLOAD_PKG.RECEIVE_STOCK__1"]).toBe(0)
    expect(graph.unitLevels["OVERLOAD_PKG.RECEIVE_STOCK__2"]).toBe(1)
  })
})

describe("真自递归（非重载）仍被正确跳过", () => {
  // 独立 fixture：单个非重载过程自调用，验证下游 self-skip 兜住、不产生自环
  let g2: ReturnType<typeof buildDependencyGraph>
  beforeAll(async () => {
    const d2 = mkdtempSync(join(tmpdir(), "self-rec-"))
    mkdirSync(d2, { recursive: true })
    writeFileSync(join(d2, "rec_body.sql"), `CREATE OR REPLACE PACKAGE REC_PKG AS
  FUNCTION fib(n NUMBER) RETURN NUMBER;
END REC_PKG;
/
CREATE OR REPLACE PACKAGE BODY REC_PKG AS
  FUNCTION fib(n NUMBER) RETURN NUMBER IS
  BEGIN
    IF n < 2 THEN RETURN n; END IF;
    RETURN fib(n - 1) + fib(n - 2);
  END;
END REC_PKG;
/
`, "utf-8")
    const idx = await scanSource(d2)
    buildInventoryFromIndex(d2, idx)
    g2 = buildDependencyGraph(d2)
  }, 30000)

  it("fib 自递归不产生自环边", () => {
    const callees = g2.callGraph["REC_PKG.FIB"] ?? []
    expect(callees).not.toContain("REC_PKG.FIB")
  })
})
