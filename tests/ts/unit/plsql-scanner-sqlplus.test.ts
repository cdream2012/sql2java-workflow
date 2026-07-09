/**
 * 回归测试：stripSqlPlusCommands 的 antlr4 优先策略。
 *
 * 验证三点：
 * 1. grammar 不认的命令（SPOOL/DEFINE）被剥，不阻断解析；
 * 2. grammar 认的命令（SET ECHO ON/PROMPT/EXIT）保留，交给 antlr4 sql_plus_command 规则；
 * 3. 单元内的 EXIT WHEN / UPDATE SET 不被误剥（旧版因 unitStart 边界正则不容忍 /*EDITIONABLE* /
 *    注释而 inUnit=false，误剥这些 → 语法断裂 → bodyLocation=null）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanWithAST } from "@workflow/plsql-scanner"

const SQL = `SPOOL install.log
SET ECHO ON
DEFINE x = 1
PROMPT starting
CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE BODY test_pkg AS
PROCEDURE issue IS
  v_remaining NUMBER := 5;
BEGIN
  FOR r IN (SELECT 1 AS id FROM dual) LOOP
    EXIT WHEN v_remaining <= 0;
    UPDATE t_inv SET qty = qty - 1 WHERE id = r.id;
    v_remaining := v_remaining - 1;
  END LOOP;
END issue;
END test_pkg;
/
EXIT
`

describe("plsql-scanner: SQL*Plus 命令处理（antlr4 优先）", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sqlplus-test-"))
    writeFileSync(join(dir, "test_pkg.sql"), SQL)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it("单元内 EXIT WHEN / UPDATE SET 不被误剥，ISSUE body 完整", async () => {
    const inv = await scanWithAST([dir], dir)
    const issue = inv.subprograms.find((s) => s.name === "ISSUE")
    expect(issue, "未识别 ISSUE 子程序").toBeDefined()
    expect(issue!.bodyLocation, "ISSUE bodyLocation 为 null").not.toBeNull()
    const [s, e] = issue!.bodyLocation!.lineRange
    // body 必须覆盖 EXIT WHEN(L10) 与 UPDATE SET(L11)，证明二者未被剥
    expect(s).toBeLessThanOrEqual(10)
    expect(e).toBeGreaterThanOrEqual(11)
  })

  it("GRANT 权限语句被剥（单行+跨行），不产生语法错误，包/子程序正常", async () => {
    const grantSql = `CREATE OR REPLACE PACKAGE BODY grant_pkg AS
PROCEDURE do_work IS
BEGIN
  NULL;
END do_work;
END grant_pkg;
/
GRANT EXECUTE ON PACKAGE grant_pkg TO role1 ;
GRANT SELECT ON grant_pkg
  TO role2 ;
`
    const d = mkdtempSync(join(tmpdir(), "sqlplus-grant-"))
    try {
      writeFileSync(join(d, "grant_pkg.sql"), grantSql)
      const inv = await scanWithAST([d], d)
      // GRANT 被剥 → 无 missing 'TO' / extraneous input 语法错误
      const grantErrs = inv.warnings.filter((w) => /missing 'TO'|extraneous input/i.test(w))
      expect(grantErrs, `GRANT 未被剥，残留语法错误: ${grantErrs.join("; ")}`).toHaveLength(0)
      const pkg = inv.packages.find((p) => p.packageName === "GRANT_PKG")
      expect(pkg, "未识别 GRANT_PKG").toBeDefined()
      const sub = inv.subprograms.find((s) => s.name === "DO_WORK")
      expect(sub?.bodyLocation, "DO_WORK bodyLocation 为 null").not.toBeNull()
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})
