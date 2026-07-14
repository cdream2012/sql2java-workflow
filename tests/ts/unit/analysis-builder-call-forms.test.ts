/**
 * analysis-builder-call-forms.test.ts — 三种调用形式的 schema 锚定解析回归测试
 *
 * PL/SQL 过程调用三种写法（Oracle 名字解析语义）：
 *   3 段 schema.pkg.proc → 完整路径精确匹配
 *   2 段 pkg.proc        → 补当前 caller schema（→ schema.pkg）
 *   1 段 proc            → 同包裸名（callerPkg）
 * scanner 的 recordCall/recordPackageRef 按段数归一化到声明键，使下游闭包 fixpoint /
 * post-filter / resolveCalleeRefNames 精确匹配。本测试构造 schema 限定包（APP.PKG_A/B/C），
 * 断言三种形式都正确建边、间接闭包经 2 段边传递（三级链 A→B→C）、未解析调用记 warning、
 * schema-less caller 的 2 段调用不误补 schema。
 *
 * 背景：真实项目（FxoptDeal）声明带 schema（fmbm.p_fm_log）而调用省 schema（p_fm_log.r_log_error），
 * 旧 recordCall 用 lastIndexOf('.') 一刀切把 pkg 拆成 p_fm_log ≠ 声明键 fmbm.p_fm_log →
 * 跨包 indirect 边被丢（P1→P2→P3 中 P3 不进闭包）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { scanSource, scanSourceLazy } from "@workflow/plsql-scanner"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import { buildDependencyGraph, clearDependencyGraphCache } from "@workflow/dependency-graph"

const SQL = `CREATE OR REPLACE PACKAGE APP.PKG_A AS
  PROCEDURE entry;
  PROCEDURE local_a;
END PKG_A;
/
CREATE OR REPLACE PACKAGE BODY APP.PKG_A AS
  PROCEDURE local_a IS BEGIN NULL; END;
  PROCEDURE entry IS
  BEGIN
    local_a;             -- 1 段裸名（Form 1A）：同包
    PKG_B.do_work;       -- 2 段（Form 2）：补 caller schema → APP.PKG_B
    APP.PKG_B.helper;    -- 3 段（Form 3）：完整路径精确
    MISSING_PKG.no_such; -- 2 段未解析 → warning（→ APP.MISSING_PKG 不存在）
  END;
END PKG_A;
/
CREATE OR REPLACE PACKAGE APP.PKG_B AS
  PROCEDURE do_work;
  PROCEDURE helper;
END PKG_B;
/
CREATE OR REPLACE PACKAGE BODY APP.PKG_B AS
  PROCEDURE helper IS BEGIN NULL; END;
  PROCEDURE do_work IS
  BEGIN
    PKG_C.deep;          -- 2 段（Form 2）：PKG_C 仅经此边可达（三级链 A→B→C）
  END;
END PKG_B;
/
CREATE OR REPLACE PACKAGE APP.PKG_C AS
  PROCEDURE deep;
END PKG_C;
/
CREATE OR REPLACE PACKAGE BODY APP.PKG_C AS
  PROCEDURE deep IS BEGIN NULL; END;
END PKG_C;
/
`

let dir: string
let graph: ReturnType<typeof buildDependencyGraph>
let index: Awaited<ReturnType<typeof scanSource>>

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "call-forms-"))
  writeFileSync(join(dir, "call_forms.sql"), SQL, "utf-8")
  index = await scanSource(dir)
  buildInventoryFromIndex(dir, index)
  graph = buildDependencyGraph(dir)
}, 30000)

afterAll(() => {
  clearDependencyGraphCache()
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe("调用形式 schema 锚定解析", () => {
  it("1 段同包裸名建边 entry → APP.PKG_A.LOCAL_A", () => {
    expect(graph.callGraph["APP.PKG_A.ENTRY"]).toContain("APP.PKG_A.LOCAL_A")
  })

  it("2 段 pkg.proc 补 caller schema 建边 entry → APP.PKG_B.DO_WORK", () => {
    expect(graph.callGraph["APP.PKG_A.ENTRY"]).toContain("APP.PKG_B.DO_WORK")
  })

  it("3 段 schema.pkg.proc 精确建边 entry → APP.PKG_B.HELPER", () => {
    expect(graph.callGraph["APP.PKG_A.ENTRY"]).toContain("APP.PKG_B.HELPER")
  })

  it("2 段间接边 do_work → APP.PKG_C.DEEP（三级链经 Form 2 传递）", () => {
    expect(graph.callGraph["APP.PKG_B.DO_WORK"]).toContain("APP.PKG_C.DEEP")
  })

  it("未解析 2 段调用记 warning（APP.MISSING_PKG.NO_SUCH）", () => {
    expect(
      index.warnings.some(w => w.includes("APP.MISSING_PKG.NO_SUCH")),
      `warnings 应含未解析调用，实际: ${JSON.stringify(index.warnings)}`,
    ).toBe(true)
  })

  it("未解析调用不进 callGraph（无 APP.MISSING_PKG 边）", () => {
    const callees = graph.callGraph["APP.PKG_A.ENTRY"] ?? []
    expect(callees.some(c => c.startsWith("APP.MISSING_PKG."))).toBe(false)
  })

  it("lazy 闭包经 2 段边传递：入口 APP.PKG_A.entry 闭包含 APP.PKG_C（仅经 B→C 2段边可达）", async () => {
    const lazy = await scanSourceLazy({ sourcePath: dir, mainEntry: "APP.PKG_A.entry" })
    const names = new Set(lazy.packages.map(p => p.packageName))
    expect(names.has("APP.PKG_A"), "入口包").toBe(true)
    expect(names.has("APP.PKG_B"), "2 段边拉入 APP.PKG_B").toBe(true)
    expect(names.has("APP.PKG_C"), "三级链末端 APP.PKG_C 经 2 段边传递可达").toBe(true)
  }, 30000)

  it("schema-less caller 的 2 段调用不误补 schema（pkg 原样 OTHER，非 BARE_PKG.OTHER）", async () => {
    const d = mkdtempSync(join(tmpdir(), "call-forms-bare-"))
    writeFileSync(join(d, "bare.sql"),
      `CREATE OR REPLACE PACKAGE BARE_PKG AS
  PROCEDURE entry;
END BARE_PKG;
/
CREATE OR REPLACE PACKAGE BODY BARE_PKG AS
  PROCEDURE entry IS
  BEGIN
    OTHER.do_thing;      -- caller BARE_PKG 无 schema → pkg 原样 OTHER（不补 schema）
  END;
END BARE_PKG;
/`, "utf-8")
    try {
      const idx = await scanSource(d)
      // OTHER 非项目包 → 未解析 warning；若误补 schema 会写成 BARE_PKG.OTHER.DO_THING
      expect(
        idx.warnings.some(w => w.includes("-> OTHER.DO_THING")),
        `schema-less 2 段应原样 pkg=OTHER，实际 warnings: ${JSON.stringify(idx.warnings)}`,
      ).toBe(true)
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  }, 30000)
})
