/**
 * directcalls-regex.test.ts — extractCallsByRegex 单元测试（regex 主路径）
 *
 * regex 主路径用 extractCallsByRegex 从 body 区间文本抽 directCalls，三段调用形式
 * （schema.pkg.proc / pkg.proc / proc）兼容，走 resolveQualifiedName 归一化。
 * scan 阶段传 subprogramIndex=null 不收窄（闭包扩展要跟到未扫包），噪声留待 finalizeInventoryIndex
 * 后过滤；generateInventory 阶段传真实 index 收窄。
 */

import { describe, it, expect } from "vitest"
import { extractCallsByRegex, resolveQualifiedName } from "@workflow/plsql-file-scanner"

// ── 单元：resolveQualifiedName 三段归一化 ──────────────────────────────────────

describe("resolveQualifiedName 三段归一化", () => {
  it("1段裸名→callerPkg；2段补callerSchema；3段精确", () => {
    expect(resolveQualifiedName("proc", "MFG_ERP.P_FOO")).toEqual({ pkg: "MFG_ERP.P_FOO", member: "PROC" })
    expect(resolveQualifiedName("P_BAR.DO_BAR", "MFG_ERP.P_FOO")).toEqual({ pkg: "MFG_ERP.P_BAR", member: "DO_BAR" })
    expect(resolveQualifiedName("MFG_ERP.P_BAR.DO_BAR", "MFG_ERP.P_FOO")).toEqual({ pkg: "MFG_ERP.P_BAR", member: "DO_BAR" })
  })

  it("去引号 + 大写归一化", () => {
    expect(resolveQualifiedName('"p_bar".do_bar', "MFG_ERP.P_FOO")).toEqual({ pkg: "MFG_ERP.P_BAR", member: "DO_BAR" })
  })

  it("caller 无 schema 前缀时 2 段不补 schema", () => {
    expect(resolveQualifiedName("P_BAR.DO_BAR", "P_FOO")).toEqual({ pkg: "P_BAR", member: "DO_BAR" })
  })
})

// ── 单元：extractCallsByRegex ──────────────────────────────────────────────────

/** 已知子程序索引：MFG_ERP.P_FOO{FOO_PROC,HELPER} / MFG_ERP.P_BAR{DO_BAR} / MFG_ERP.P_BAZ{DO_BAZ} */
function makeIndex(): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>()
  idx.set("MFG_ERP.P_FOO", new Set(["FOO_PROC", "HELPER"]))
  idx.set("MFG_ERP.P_BAR", new Set(["DO_BAR"]))
  idx.set("MFG_ERP.P_BAZ", new Set(["DO_BAZ"]))
  return idx
}

// foo_proc 声明头 + 三段调用 + 噪声（类型构造/集合访问/SQL内建/嵌套声明头/未解析包）
const CODE_MIXED = `PROCEDURE foo_proc(p IN NUMBER) IS
  v NUMBER;
BEGIN
  MFG_ERP.P_BAR.DO_BAR(p);
  P_BAZ.DO_BAZ(p);
  helper(p);
  pkg.t_rec_type(p);
  pkg.g_array(1);
  TO_CHAR(p);
  v := pkg.compute(p);
  PROCEDURE inner(x NUMBER) IS BEGIN NULL; END inner;
END foo_proc;
`

describe("extractCallsByRegex 收窄（传 subprogramIndex）", () => {
  const calls = extractCallsByRegex(CODE_MIXED, "MFG_ERP.P_FOO", [1, 20], makeIndex())
  const keys = calls.map(c => `${c.package}.${c.name}`).sort()

  it("抽得三段形式调用（schema.pkg.proc / pkg.proc / 裸名同包）", () => {
    expect(keys).toEqual([
      "MFG_ERP.P_BAR.DO_BAR",   // 3 段 schema.pkg.proc
      "MFG_ERP.P_BAZ.DO_BAZ",   // 2 段 pkg.proc（补 callerSchema=MFG_ERP）
      "MFG_ERP.P_FOO.HELPER",   // 1 段裸名同包
    ])
  })

  it("kind 统一标 procedure", () => {
    expect(calls.every(c => c.kind === "procedure")).toBe(true)
  })

  it("line 为调用点所在文件行号", () => {
    const doBar = calls.find(c => c.name === "DO_BAR")!
    expect(doBar.line).toBe(4) // CODE_MIXED 第 4 行
  })

  it("排除声明头：foo_proc 声明头（在索引里）不被误抽为自调用", () => {
    expect(keys).not.toContain("MFG_ERP.P_FOO.FOO_PROC")
  })

  it("排除嵌套声明头 inner（行首 PROCEDURE）", () => {
    expect(keys).not.toContain("MFG_ERP.P_FOO.INNER")
  })

  it("收窄丢弃未解析包的类型构造 / 集合访问 / 变量方法（pkg.* 不在索引）", () => {
    expect(keys).not.toContain("MFG_ERP.PKG.T_REC_TYPE")
    expect(keys).not.toContain("MFG_ERP.PKG.G_ARRAY")
    expect(keys).not.toContain("MFG_ERP.PKG.COMPUTE")
  })

  it("SQL_PSEUDO 内建函数 TO_CHAR 丢弃", () => {
    expect(keys).not.toContain("MFG_ERP.P_FOO.TO_CHAR")
  })
})

describe("extractCallsByRegex 不收窄（传 null，scan 阶段）", () => {
  const calls = extractCallsByRegex(CODE_MIXED, "MFG_ERP.P_FOO", [1, 20], null)
  const keys = calls.map(c => `${c.package}.${c.name}`).sort()

  it("三段真实调用保留", () => {
    expect(keys).toContain("MFG_ERP.P_BAR.DO_BAR")
    expect(keys).toContain("MFG_ERP.P_BAZ.DO_BAZ")
    expect(keys).toContain("MFG_ERP.P_FOO.HELPER")
  })

  it("不收窄：类型构造 / 集合访问 / 变量方法保留（噪声留待 finalizeInventoryIndex 后过滤）", () => {
    expect(keys).toContain("MFG_ERP.PKG.T_REC_TYPE")
    expect(keys).toContain("MFG_ERP.PKG.G_ARRAY")
    expect(keys).toContain("MFG_ERP.PKG.COMPUTE")
  })

  it("声明头 + SQL_PSEUDO 仍排除（不依赖收窄）", () => {
    expect(keys).not.toContain("MFG_ERP.P_FOO.FOO_PROC")
    expect(keys).not.toContain("MFG_ERP.P_FOO.INNER")
    expect(keys).not.toContain("MFG_ERP.P_FOO.TO_CHAR")
  })
})

describe("extractCallsByRegex 区间隔离", () => {
  // 同包两个子程序：a_proc 调 DO_BAR，b_proc 调 DO_BAZ，body 分处不同行区间
  const CODE_TWO = `PROCEDURE a_proc IS
BEGIN
  P_BAR.DO_BAR(1);
END a_proc;
PROCEDURE b_proc IS
BEGIN
  P_BAZ.DO_BAZ(1);
END b_proc;
`
  it("a_proc 区间 [1,3] 只抽 DO_BAR，不串到 b_proc 的 DO_BAZ", () => {
    const calls = extractCallsByRegex(CODE_TWO, "MFG_ERP.P_FOO", [1, 3], makeIndex())
    expect(calls.map(c => c.name).sort()).toEqual(["DO_BAR"])
  })
  it("b_proc 区间 [5,7] 只抽 DO_BAZ，不串到 a_proc 的 DO_BAR", () => {
    const calls = extractCallsByRegex(CODE_TWO, "MFG_ERP.P_FOO", [5, 7], makeIndex())
    expect(calls.map(c => c.name).sort()).toEqual(["DO_BAZ"])
  })
})

describe("extractCallsByRegex 去重", () => {
  it("同一调用点不重复；不同行同 callee 各保留", () => {
    const code = `BEGIN
  P_BAR.DO_BAR(1);
  P_BAR.DO_BAR(2);
END;
`
    const calls = extractCallsByRegex(code, "MFG_ERP.P_FOO", [1, 10], makeIndex())
    expect(calls.length).toBe(2) // 两行各一条，line 不同
    expect(calls.every(c => c.name === "DO_BAR")).toBe(true)
  })
})

describe("extractCallsByRegex 剥注释", () => {
  it("行注释 / 块注释里的调用不被抽（AST 不解析注释，regex 须对齐）", () => {
    const code = `BEGIN
  -- P_BAR.DO_BAR(1);
  /* P_BAZ.DO_BAZ(2); */
  P_BAR.DO_BAR(3);
END;
`
    const calls = extractCallsByRegex(code, "MFG_ERP.P_FOO", [1, 10], makeIndex())
    expect(calls.length).toBe(1)             // 仅第 4 行真实调用
    expect(calls[0].name).toBe("DO_BAR")
    expect(calls[0].line).toBe(4)
  })
})
