/**
 * verify-summary-builder.test.ts — buildVerifySummary 动态聚合测试
 *
 * verify 只做动态检查（mvn 日志解析 + 编译/测试失败归因 + 聚合 verify-summary.json）。
 * 验证：编译成功/失败、测试归因、环境跳过、产出过 VerifySummarySchema（含 allPassedRefine）。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildVerifySummary } from "@workflow/verify-summary-builder"
import { VerifySummarySchema } from "@workflow/artifact-schemas"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "verify-summary-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function setup(packages: string[], opts: { mappings?: any[]; procClassNames?: any[]; files?: Record<string, string[]> } = {}) {
  // Stage C：packageMappings 从 plan.json 移到 scaffold.json（verify 读 scaffold.json）
  writeFileSync(
    join(dir, "scaffold.json"),
    JSON.stringify({
      projectRoot: "/tmp/proj",
      packageMappings: opts.mappings ?? [],
      generated: { procClassNames: opts.procClassNames ?? [] },
    }),
    "utf-8",
  )
  writeFileSync(join(dir, "inventory.json"), JSON.stringify({ packageNames: packages }), "utf-8")
  for (const pkg of packages) {
    mkdirSync(join(dir, "translations", pkg), { recursive: true })
    writeFileSync(
      join(dir, "translations", pkg, "translation.json"),
      JSON.stringify({ packageName: pkg, files: (opts.files?.[pkg] ?? []).map(p => ({ path: p, role: "service-impl" })) }),
      "utf-8",
    )
  }
}

function writeCompileLog(content: string) {
  writeFileSync(join(dir, "verify-compile.log"), content, "utf-8")
}
function writeTestLog(content: string) {
  writeFileSync(join(dir, "verify-test.log"), content, "utf-8")
}

describe("buildVerifySummary", () => {
  it("编译+测试全过 → allPassed=true, compilation.success=true", () => {
    setup(["PKG_A", "PKG_B"])
    writeCompileLog("[INFO] Building\n[INFO] BUILD SUCCESS")
    writeTestLog("Tests run: 4, Failures: 0, Errors: 0, Skipped: 0")
    const r = buildVerifySummary(dir)
    expect(r.allPassed).toBe(true)
    expect(r.compilationSuccess).toBe(true)
    expect(r.totalTests).toBe(4)
    expect(r.testsPassed).toBe(4)
  })

  it("编译错误归因到对应包 → 该包 passed=false，其它包 passed=true", () => {
    setup(
      ["PKG_A", "PKG_B"],
      { files: { PKG_A: ["src/main/java/com/a/AServiceImpl.java"], PKG_B: ["src/main/java/com/b/BServiceImpl.java"] } },
    )
    writeCompileLog([
      "[INFO] Compiling...",
      "[ERROR] /tmp/proj/src/main/java/com/a/AServiceImpl.java:[12,5] 找不到符号 OrderDO",
      "[INFO] BUILD FAILURE",
    ].join("\n"))
    writeTestLog("Tests run: 2, Failures: 0, Errors: 0, Skipped: 0")
    const r = buildVerifySummary(dir)
    expect(r.compilationSuccess).toBe(false)
    const summary = JSON.parse(readFileSync(join(dir, "verify-summary.json"), "utf-8"))
    const a = summary.packageResults.find((p: any) => p.packageName === "PKG_A")
    const b = summary.packageResults.find((p: any) => p.packageName === "PKG_B")
    expect(a.passed).toBe(false) // 编译错误归因到 PKG_A
    expect(b.passed).toBe(true)
    expect(summary.compilation.errors.length).toBe(1)
  })

  it("测试失败按 procClassNames 归因到包 → 该包 passed=false", () => {
    setup(
      ["PKG_A"],
      {
        mappings: [{ plsqlSchema: "", plsqlPackage: "PKG_A", components: [{ role: "service-impl" }] }],
        procClassNames: [{ plsqlSchema: "", plsqlPackage: "PKG_A", refName: "CREATE_ORDER", className: "CreateOrder" }],
      },
    )
    writeCompileLog("[INFO] BUILD SUCCESS")
    writeTestLog([
      "Tests run: 2, Failures: 1, Errors: 0, Skipped: 0",
      "<<< FAILURE! - [service.impl.CreateOrderServiceImplTest.createOrder_shouldComplete]",
    ].join("\n"))
    const r = buildVerifySummary(dir)
    expect(r.testsPassed).toBe(1)
    const summary = JSON.parse(readFileSync(join(dir, "verify-summary.json"), "utf-8"))
    expect(summary.packageResults[0].passed).toBe(false)
    expect(summary.testExecution.testErrors[0].testType).toBe("unit")
  })

  it("测试失败按 procClassNames 归因到包 → 该包 passed=false（per-proc）", () => {
    setup(
      ["PKG_A"],
      {
        mappings: [{ plsqlSchema: "", plsqlPackage: "PKG_A", components: [{ role: "service-impl" }] }],
        procClassNames: [{ plsqlSchema: "", plsqlPackage: "PKG_A", refName: "CREATE_ORDER", className: "CreateOrder" }],
      },
    )
    writeCompileLog("[INFO] BUILD SUCCESS")
    writeTestLog([
      "Tests run: 2, Failures: 1, Errors: 0, Skipped: 0",
      "<<< FAILURE! - [service.impl.CreateOrderServiceImplTest.createOrder_shouldComplete]",
    ].join("\n"))
    const r = buildVerifySummary(dir)
    expect(r.testsPassed).toBe(1)
    const summary = JSON.parse(readFileSync(join(dir, "verify-summary.json"), "utf-8"))
    expect(summary.packageResults[0].passed).toBe(false)
    expect(summary.testExecution.testErrors[0].testType).toBe("unit")
  })

  it("跨包同名过程去重隔离不误归因（PKG_B 的 Process2 测试不命中 PKG_A 的 Process）", () => {
    setup(
      ["PKG_A", "PKG_B"],
      {
        mappings: [
          { plsqlSchema: "", plsqlPackage: "PKG_A", components: [{ role: "service-impl" }] },
          { plsqlSchema: "", plsqlPackage: "PKG_B", components: [{ role: "service-impl" }] },
        ],
        // 跨包同名 PROCESS 碰撞：PKG_A 首现 Process，PKG_B 去重为 Process2
        procClassNames: [
          { plsqlSchema: "", plsqlPackage: "PKG_A", refName: "PROCESS", className: "Process" },
          { plsqlSchema: "", plsqlPackage: "PKG_B", refName: "PROCESS", className: "Process2" },
        ],
      },
    )
    writeCompileLog("[INFO] BUILD SUCCESS")
    writeTestLog([
      "Tests run: 1, Failures: 1, Errors: 0, Skipped: 0",
      "<<< FAILURE! - [service.impl.Process2ServiceImplTest.process_shouldComplete]",
    ].join("\n"))
    const r = buildVerifySummary(dir)
    expect(r.testsPassed).toBe(0)
    const summary = JSON.parse(readFileSync(join(dir, "verify-summary.json"), "utf-8"))
    const a = summary.packageResults.find((p: any) => p.packageName === "PKG_A")
    const b = summary.packageResults.find((p: any) => p.packageName === "PKG_B")
    expect(a.passed).toBe(true)   // Process2 不应命中 PKG_A 的 Process
    expect(b.passed).toBe(false)  // 真正失败的包
  })

  it("IntegrationTest 失败 → testType=integration", () => {
    setup(["PKG_A"], {
      mappings: [{ plsqlSchema: "", plsqlPackage: "PKG_A", components: [{ role: "mapper" }] }],
      procClassNames: [{ plsqlSchema: "", plsqlPackage: "PKG_A", refName: "SELECT_BY_ID", className: "SelectById" }],
    })
    writeCompileLog("BUILD SUCCESS")
    writeTestLog([
      "Tests run: 1, Failures: 0, Errors: 1, Skipped: 0",
      "<<< ERROR! - [mapper.SelectByIdMapperIntegrationTest.selectById]",
    ].join("\n"))
    buildVerifySummary(dir)
    const summary = JSON.parse(readFileSync(join(dir, "verify-summary.json"), "utf-8"))
    expect(summary.testExecution.testErrors[0].testType).toBe("integration")
    expect(summary.packageResults[0].passed).toBe(false)
  })

  it("无 mvn 日志（环境不可用）→ compilation.skipped, testExecution.executed=false, GLOBAL unresolvedIssue", () => {
    setup(["PKG_A"])
    // 不写 verify-compile.log / verify-test.log
    const r = buildVerifySummary(dir)
    expect(r.compilationSuccess).toBe(false)
    const summary = JSON.parse(readFileSync(join(dir, "verify-summary.json"), "utf-8"))
    expect(summary.compilation.skipped).toBe(true)
    expect(summary.testExecution.executed).toBe(false)
    expect(summary.unresolvedIssues.some((u: any) => u.packageName === "GLOBAL")).toBe(true)
  })

  it("产出的 verify-summary.json 通过 VerifySummarySchema", () => {
    setup(["PKG_A", "PKG_B"])
    writeCompileLog("BUILD SUCCESS")
    writeTestLog("Tests run: 3, Failures: 0, Errors: 0, Skipped: 0")
    buildVerifySummary(dir)
    const raw = JSON.parse(readFileSync(join(dir, "verify-summary.json"), "utf-8"))
    expect(VerifySummarySchema.safeParse(raw).success).toBe(true)
    // allPassed 须与 packageResults.every(passed) 一致
    expect(raw.allPassed).toBe(raw.packageResults.every((p: { passed: boolean }) => p.passed))
  })

  it("不再写 per-package verify.json", () => {
    setup(["PKG_A"])
    writeCompileLog("BUILD SUCCESS")
    writeTestLog("Tests run: 1, Failures: 0, Errors: 0, Skipped: 0")
    buildVerifySummary(dir)
    expect(existsSync(join(dir, "translations", "PKG_A", "verify.json"))).toBe(false)
  })
})
