/**
 * scaffold-input-builder.test.ts — generateScaffoldInput 聚合单测（packages-only）
 *
 * 用合成 inventory + packages 样本验证：
 *   - 仅保留 packages 窄字段，丢弃噪声（types/exceptions/bodyPath/estimatedLoc/complexity）
 *   - sourcePath 取 absolutePaths[0] ?? headerPath（constants/variables 空时兜底读源码用）
 *   - 稳定顺序保持（packageNames 序 → 包内 procedures/functions 原序）
 *   - tables/sequences/views 不进产物（DO/schema-h2 由 do-schema-builder 引擎生成）
 *   - 单文件缺失容错（warn 跳过，不阻断）
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { generateScaffoldInput } from "@workflow/scaffold-input-builder"

describe("generateScaffoldInput", () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "scaffold-input-"))
    mkdirSync(join(dir, "packages"), { recursive: true })
    // tables 目录存在但聚合器不应再读它（DO/schema-h2 改由 do-schema-builder 读）
    mkdirSync(join(dir, "tables"), { recursive: true })

    writeFileSync(join(dir, "inventory.json"), JSON.stringify({
      packageNames: ["SCHEMA.PKG_A", "SCHEMA.PKG_B"],
      tableNames: ["SCHEMA.T_FOO"], // 不应进 packages-only 产物
      sequences: [{ name: "SCHEMA.SEQ_FOO" }], // 不应进产物
      views: [{ name: "SCHEMA.V_FOO" }], // 不应进产物
    }))

    writeFileSync(join(dir, "packages", "SCHEMA.PKG_A.json"), JSON.stringify({
      packageName: "SCHEMA.PKG_A",
      absolutePaths: ["/proj/resources/SCHEMA/PACKAGE/PKG_A.sql"],
      headerPath: "/proj/resources/SCHEMA/PACKAGE/PKG_A.sql",
      bodyPath: null,
      constants: [{ name: "C_RATE", value: "0.1", type: "NUMBER" }],
      variables: [], // 扫描器留空 → 兜底读 source.sql
      exceptions: [{ name: "E_NOISY" }], // 噪声，应丢
      types: [{ name: "T_NOISY" }], // 噪声，应丢
      procedures: ["DO_A", "DO_B"],
      functions: ["GET_A"],
      estimatedLoc: 999, // 噪声
      complexity: 999, // 噪声
    }))

    writeFileSync(join(dir, "packages", "SCHEMA.PKG_B.json"), JSON.stringify({
      packageName: "SCHEMA.PKG_B",
      absolutePaths: [], // 空 → 回退 headerPath
      headerPath: "/proj/resources/SCHEMA/PACKAGE/PKG_B.sql",
      constants: [],
      variables: [{ name: "G_STATE", type: "VARCHAR2", defaultValue: null }],
      procedures: [],
      functions: ["GET_B"],
    }))
  })

  it("落盘 scaffold-input.json 且 packages-only（无 tables/sequences/views）", () => {
    generateScaffoldInput(dir)
    const out = JSON.parse(readFileSync(join(dir, "scaffold-input.json"), "utf-8"))
    expect(out.packageNames).toEqual(["SCHEMA.PKG_A", "SCHEMA.PKG_B"])
    expect(out.packages).toHaveLength(2)
    // tables/sequences/views 不再进产物
    expect(out.tables).toBeUndefined()
    expect(out.sequences).toBeUndefined()
    expect(out.views).toBeUndefined()
  })

  it("packages 仅保留窄字段 + sourcePath，丢弃 types/exceptions/bodyPath/loc/complexity", () => {
    const out = JSON.parse(readFileSync(join(dir, "scaffold-input.json"), "utf-8"))
    const a = out.packages[0]
    expect(a.packageName).toBe("SCHEMA.PKG_A")
    expect(a.sourcePath).toBe("/proj/resources/SCHEMA/PACKAGE/PKG_A.sql")
    expect(a.constants).toEqual([{ name: "C_RATE", value: "0.1", type: "NUMBER" }])
    expect(a.variables).toEqual([])
    expect(a.procedures).toEqual(["DO_A", "DO_B"])
    expect(a.functions).toEqual(["GET_A"])
    // 噪声字段已丢
    expect(a.types).toBeUndefined()
    expect(a.exceptions).toBeUndefined()
    expect(a.bodyPath).toBeUndefined()
    expect(a.estimatedLoc).toBeUndefined()
    expect(a.complexity).toBeUndefined()
  })

  it("sourcePath 在 absolutePaths 空时回退 headerPath", () => {
    const out = JSON.parse(readFileSync(join(dir, "scaffold-input.json"), "utf-8"))
    expect(out.packages[1].sourcePath).toBe("/proj/resources/SCHEMA/PACKAGE/PKG_B.sql")
  })

  it("packages 保持 packageNames 稳定顺序", () => {
    const out = JSON.parse(readFileSync(join(dir, "scaffold-input.json"), "utf-8"))
    expect(out.packages.map((p: any) => p.packageName)).toEqual(["SCHEMA.PKG_A", "SCHEMA.PKG_B"])
  })

  it("inventory.json 缺失时容错返回空结构（不抛）", () => {
    const empty = mkdtempSync(join(tmpdir(), "scaffold-input-empty-"))
    const out = generateScaffoldInput(empty)
    expect(out.packageNames).toEqual([])
    expect(out.packages).toEqual([])
    // 不落盘空产物
    expect(existsSync(join(empty, "scaffold-input.json"))).toBe(false)
  })
})
