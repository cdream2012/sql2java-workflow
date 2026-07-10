/**
 * repair-missing-locations.test.ts — buildInventoryFromIndex 补齐缺失 location 集成测试
 *
 * AST 语法错误恢复可能漏抽子程序节点致 bodyLocation/headerLocation 为 null。buildInventoryFromIndex
 * 落盘前应按包名+子程序名用 regex 在包级 bodyPath/headerPath 文件里补齐 lineRange；找不到落 TODO warning。
 * 本测试手工构造 bodyLocation=null 的 idx（模拟 AST 漏抽），验证补齐 + 失败兜底。
 */

import { describe, it, expect, beforeAll } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildInventoryFromIndex } from "@workflow/inventory-builder"
import type { InventoryIndex, PackageInfo, SubprogramInfo } from "@workflow/plsql-scanner"

const BODY_SQL = `CREATE OR REPLACE PACKAGE BODY PKG_REPAIR IS
  PROCEDURE do_work(p IN NUMBER) IS
  BEGIN
    NULL;
  END do_work;
END PKG_REPAIR;
`

let dir: string
let bodyFile: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "inv-repair-"))
  bodyFile = join(dir, "PKG_REPAIR.body.sql")
  writeFileSync(bodyFile, BODY_SQL, "utf-8")
})

function makeIdx(bodyPath: string | null): InventoryIndex {
  const pkg: PackageInfo = {
    packageName: "PKG_REPAIR",
    absolutePaths: bodyPath ? [bodyPath] : [],
    headerPath: null,
    bodyPath,
    constants: [], variables: [], exceptions: [], types: [],
    functions: [], procedures: ["DO_WORK"], estimatedLoc: 5,
  }
  const sub: SubprogramInfo = {
    name: "DO_WORK",
    type: "PROCEDURE",
    belongToPackage: "PKG_REPAIR",
    overloadIndex: null,
    isPrivate: false,
    headerLocation: null,
    bodyLocation: null, // 模拟 AST 语法错误恢复漏抽
    parameters: [],
    returnType: null,
    loc: 0,
    directCalls: [],
    packageRefs: [],
  }
  return {
    sourcePath: dir,
    scannedAt: new Date().toISOString(),
    scannerUsed: "ast",
    warnings: [],
    packages: [pkg],
    subprograms: [sub],
    tables: [], triggers: [], views: [], sequences: [], standaloneProcedures: [],
  } as InventoryIndex
}

function readSubprogram(outDir: string): any {
  return JSON.parse(readFileSync(join(outDir, "subprograms", "PKG_REPAIR.DO_WORK.json"), "utf-8"))
}

describe("buildInventoryFromIndex 补齐缺失 location", () => {
  it("bodyLocation 缺失：按包名+过程名在 bodyPath 文件补齐 lineRange，无 TODO", () => {
    const outDir = join(dir, "case1")
    mkdirSync(outDir, { recursive: true })
    const r = buildInventoryFromIndex(outDir, makeIdx(bodyFile))
    const sub = readSubprogram(outDir)
    expect(sub.bodyLocation).not.toBeNull()
    expect(sub.bodyLocation.absolutePath).toBe(bodyFile)
    expect(sub.bodyLocation.lineRange).toEqual([2, 5])
    expect(r.warnings.some(w => w.includes("TODO[body-location]"))).toBe(false)
  })

  it("包级 bodyPath 也缺失：落 TODO warning，bodyLocation 保持 null", () => {
    const outDir = join(dir, "case2")
    mkdirSync(outDir, { recursive: true })
    const r = buildInventoryFromIndex(outDir, makeIdx(null))
    expect(r.warnings.some(w => w.includes("TODO[body-location]: PKG_REPAIR.DO_WORK"))).toBe(true)
    expect(readSubprogram(outDir).bodyLocation).toBeNull()
  })

  it("bodyPath 有但文件内找不到该子程序：落 TODO warning", () => {
    const otherBody = join(dir, "empty_body.sql")
    writeFileSync(otherBody, "CREATE OR REPLACE PACKAGE BODY PKG_REPAIR IS\nEND PKG_REPAIR;\n", "utf-8")
    const outDir = join(dir, "case3")
    mkdirSync(outDir, { recursive: true })
    const r = buildInventoryFromIndex(outDir, makeIdx(otherBody))
    expect(r.warnings.some(w => w.includes("TODO[body-location]"))).toBe(true)
    expect(readSubprogram(outDir).bodyLocation).toBeNull()
  })

  it("location 齐全时不触发补齐（无 TODO、无副作用）", () => {
    const idx = makeIdx(bodyFile)
    idx.subprograms[0].bodyLocation = { absolutePath: bodyFile, lineRange: [2, 5] }
    idx.subprograms[0].headerLocation = { absolutePath: bodyFile, lineRange: [2, 5] }
    const outDir = join(dir, "case4")
    mkdirSync(outDir, { recursive: true })
    const r = buildInventoryFromIndex(outDir, idx)
    expect(r.warnings.some(w => w.includes("TODO["))).toBe(false)
  })
})
