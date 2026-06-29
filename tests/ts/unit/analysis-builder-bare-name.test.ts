/**
 * analysis-builder-bare-name.test.ts — 同包 bare-name 调用边补全回归测试（feat/proc-entry-scope D）
 *
 * scanCallSites 只识别 `PKG.PROC` 点号调用，遗漏同包裸名互调。scanBareCallSites 补同包裸名调用
 * 边（`helper_proc;` / `do_thing(...)`），严格白名单（命中本包子程序名）+ 排除声明/结尾/点号调用。
 * 本测试构造一个含裸名调用的包，断言 callGraph 正确建边且无幻边/自环污染。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildDependencyGraphFromIndex } from "@workflow/analysis-builder"

let dir: string
let analysis: any

const BODY = `create or replace package body BARE_PKG as
procedure entry_proc is
begin
  helper_proc;
  do_thing(1);
  OTHER_PKG.cross_call;
end;
procedure helper_proc is begin null; end;
procedure do_thing(p_id number) is begin null; end;
end;
/
`

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bare-name-"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "bare_pkg_body.sql"), BODY, "utf-8")
  const index = {
    sourcePath: dir,
    packages: [{
      name: "BARE_PKG",
      bodyFile: "bare_pkg_body.sql",
      procedures: [
        { name: "entry_proc", type: "PROCEDURE", lineRange: [2, 6] },
        { name: "helper_proc", type: "PROCEDURE", lineRange: [7, 7] },
        { name: "do_thing", type: "PROCEDURE", lineRange: [8, 8] },
      ],
    }],
  }
  writeFileSync(join(dir, "inventory-index.json"), JSON.stringify(index, null, 2), "utf-8")
  buildDependencyGraphFromIndex(dir)
  analysis = JSON.parse(readFileSync(join(dir, "dependency-graph.json"), "utf-8"))
}, 30000)

afterAll(() => { /* OS 清理 tmpdir */ })

describe("analysis-builder bare-name 边补全", () => {

  it("entry_proc 裸名调用 helper_proc 建边（无参语句形式 `helper_proc;`）", () => {
    expect(analysis.callGraph["BARE_PKG.entry_proc"]).toContain("BARE_PKG.helper_proc")
  })

  it("entry_proc 裸名调用 do_thing 建边（带参 `do_thing(...)`）", () => {
    expect(analysis.callGraph["BARE_PKG.entry_proc"]).toContain("BARE_PKG.do_thing")
  })

  it("OTHER_PKG.cross_call 不产生 BARE_PKG 内裸边（点号调用 + 包不在 inventory）", () => {
    const callees = analysis.callGraph["BARE_PKG.entry_proc"] ?? []
    expect(callees).not.toContain("BARE_PKG.cross_call")
    expect(callees.some((c: string) => c.startsWith("OTHER_PKG."))).toBe(false)
  })

  it("过程声明 `procedure do_thing(...)` 不误判为调用（无 do_thing→do_thing 自环）", () => {
    const callees = analysis.callGraph["BARE_PKG.do_thing"] ?? []
    expect(callees).not.toContain("BARE_PKG.do_thing")
  })

  it("helper_proc / do_thing 无出边（叶子，不被 entry 之外的调用）", () => {
    expect(analysis.callGraph["BARE_PKG.helper_proc"] ?? []).toEqual([])
    expect(analysis.callGraph["BARE_PKG.do_thing"] ?? []).toEqual([])
  })

  it("procedureOrder 含全部 3 个 unit 且无 SCC 膨胀（无幻边成环）", () => {
    const units = analysis.procedureOrder.flat()
    expect(units.sort()).toEqual(["BARE_PKG.do_thing", "BARE_PKG.entry_proc", "BARE_PKG.helper_proc"])
    // entry 依赖 helper/do_thing → 后两者在前；无环 → sccGroups 全是单元素（不入 sccGroups>1）
    expect(analysis.sccGroups).toEqual([])
  })
})
