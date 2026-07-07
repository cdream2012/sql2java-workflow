/**
 * package-parser.test.ts — parseInventoryPackage 形状/边界测试
 *
 * 重点：点号包名（schema.package，如 FM 与 FM.XXX 共存）的 subprograms 聚合必须精确匹配
 * belongToPackage，不能 startsWith(`${pkg}.`) 前缀匹配——否则 FM.XXX 的子程序被误并入 FM。
 */
import { describe, it, expect, beforeAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseInventoryPackage } from "@workflow/package-parser"

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pkg-parser-"))
  mkdirSync(join(dir, "packages"), { recursive: true })
  mkdirSync(join(dir, "subprograms"), { recursive: true })
  // 两个点号相邻包：FM 与 FM.XXX
  for (const pkg of ["FM", "FM.XXX"]) {
    writeFileSync(join(dir, "packages", `${pkg}.json`), JSON.stringify({
      packageName: pkg, absolutePaths: [`${pkg}.sql`], headerPath: `${pkg}.sql`, bodyPath: `${pkg}.sql`,
      constants: [], variables: [], exceptions: [], types: [], functions: [], procedures: [], estimatedLoc: 0,
    }), "utf-8")
  }
  const writeSub = (pkg: string, name: string) => writeFileSync(
    join(dir, "subprograms", `${pkg}.${name}.json`),
    JSON.stringify({ name, type: "PROCEDURE", belongToPackage: pkg, overloadIndex: null, isPrivate: false,
      headerLocation: null, bodyLocation: { absolutePath: `${pkg}.sql`, lineRange: [1, 2] },
      parameters: [], returnType: null, loc: 2, directCalls: [], packageRefs: [] }), "utf-8")
  writeSub("FM", "DO_A")
  writeSub("FM.XXX", "DO_B")
})

describe("parseInventoryPackage 点号包名精确匹配", () => {
  it("FM 仅聚合 FM.DO_A，不误并 FM.XXX.DO_B", () => {
    const r = parseInventoryPackage(dir, "FM")!
    expect(r).not.toBeNull()
    expect(r.subprograms.map(s => s.name).sort()).toEqual(["DO_A"])
  })

  it("FM.XXX 仅聚合 FM.XXX.DO_B", () => {
    const r = parseInventoryPackage(dir, "FM.XXX")!
    expect(r).not.toBeNull()
    expect(r.subprograms.map(s => s.name).sort()).toEqual(["DO_B"])
  })
})
