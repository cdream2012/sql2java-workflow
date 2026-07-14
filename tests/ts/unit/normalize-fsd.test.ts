/**
 * normalize-fsd.test.ts — FSD 文件名规范化单测
 *
 * analyze worker 偶发小写命名 FSD（如 format_error_stack.md），下游用大写 refOf(unit)
 * 定位（analyze existsSync + translate prompt 注入路径）。macOS 大小写不敏感能蒙混，
 * Linux 大小写敏感会阻断 advance / 读不到 FSD。normalizeFsdFilenames 在校验前把
 * case 变体重命名为规范大写 refName.md（幂等，清重复副本，缺失不报）。
 *
 * 注：macOS APFS 默认大小写不敏感，existsSync 无法区分大小写——故断言一律用
 * readdirSync 取磁盘实际存储名，而非 existsSync。
 *
 * SUT: normalizeFsdFilenames（@plugins 导出，纯盘操作）。
 */

import { describe, it, expect, beforeEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { normalizeFsdFilenames } from "@plugins/workflow-engine"

function writeFsd(dir: string, pkgDir: string, fileName: string, content = "# FSD\n内容") {
  mkdirSync(join(dir, "fsd", pkgDir), { recursive: true })
  writeFileSync(join(dir, "fsd", pkgDir, fileName), content, "utf-8")
}

/** 取 fsd/{pkgDir}/ 下实际存储的文件名（排序），用 readdirSync 区分大小写 */
function listFsd(dir: string, pkgDir: string): string[] {
  return readdirSync(join(dir, "fsd", pkgDir)).sort()
}

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "normalize-fsd-")) })

describe("normalizeFsdFilenames", () => {
  it("小写 FSD → 重命名为大写 refName（内容保留）", () => {
    writeFsd(dir, "PKG_A", "format_error_stack.md", "lower")
    normalizeFsdFilenames(dir, ["PKG_A.FORMAT_ERROR_STACK"])
    expect(listFsd(dir, "PKG_A")).toEqual(["FORMAT_ERROR_STACK.md"])
    expect(readFileSync(join(dir, "fsd", "PKG_A", "FORMAT_ERROR_STACK.md"), "utf-8")).toBe("lower")
  })

  it("已规范（大写）→ 不动（幂等，二次调用仍不变）", () => {
    writeFsd(dir, "PKG_A", "LOG_ERROR.md", "upper")
    normalizeFsdFilenames(dir, ["PKG_A.LOG_ERROR"])
    expect(listFsd(dir, "PKG_A")).toEqual(["LOG_ERROR.md"])
    expect(readFileSync(join(dir, "fsd", "PKG_A", "LOG_ERROR.md"), "utf-8")).toBe("upper")
    normalizeFsdFilenames(dir, ["PKG_A.LOG_ERROR"])
    expect(listFsd(dir, "PKG_A")).toEqual(["LOG_ERROR.md"])
  })

  it("重载 refName（__序号）正确重命名", () => {
    writeFsd(dir, "PKG_A", "receive_stock__1.md", "overload1")
    normalizeFsdFilenames(dir, ["PKG_A.RECEIVE_STOCK__1"])
    expect(listFsd(dir, "PKG_A")).toEqual(["RECEIVE_STOCK__1.md"])
  })

  it("缺失 FSD → 不报错不创建（由完整性校验负责）", () => {
    mkdirSync(join(dir, "fsd", "PKG_A"), { recursive: true })
    expect(() => normalizeFsdFilenames(dir, ["PKG_A.MISSING"])).not.toThrow()
    expect(listFsd(dir, "PKG_A")).toEqual([])
  })

  it("多 unit 混合：小写改名、大写不动、缺失跳过", () => {
    writeFsd(dir, "PKG_A", "format_error_stack.md", "a")
    writeFsd(dir, "PKG_A", "LOG_ERROR.md", "b")
    mkdirSync(join(dir, "fsd", "PKG_A"), { recursive: true })
    normalizeFsdFilenames(dir, ["PKG_A.FORMAT_ERROR_STACK", "PKG_A.LOG_ERROR", "PKG_A.MISSING"])
    expect(listFsd(dir, "PKG_A")).toEqual(["FORMAT_ERROR_STACK.md", "LOG_ERROR.md"])
  })

  it("fsd/ 目录不存在 → 安全无操作", () => {
    expect(() => normalizeFsdFilenames(dir, ["PKG_A.X"])).not.toThrow()
  })

  it("包目录大小写不一致 → findDirCaseInsensitive 定位后规范化", () => {
    // unit 用规范包名 PKG_A，但磁盘目录是 pkg_a（小写）
    writeFsd(dir, "pkg_a", "format_error_stack.md", "lower")
    normalizeFsdFilenames(dir, ["PKG_A.FORMAT_ERROR_STACK"])
    expect(listFsd(dir, "pkg_a")).toEqual(["FORMAT_ERROR_STACK.md"])
  })

  it("跨包：各包独立规范化", () => {
    writeFsd(dir, "PKG_A", "lower_a.md", "a")
    writeFsd(dir, "PKG_B", "LOWER_B.md", "b")
    normalizeFsdFilenames(dir, ["PKG_A.LOWER_A", "PKG_B.LOWER_B"])
    expect(listFsd(dir, "PKG_A")).toEqual(["LOWER_A.md"])
    expect(listFsd(dir, "PKG_B")).toEqual(["LOWER_B.md"])
  })
})
