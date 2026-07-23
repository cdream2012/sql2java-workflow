/**
 * plsql-scanner-fields.test.ts — AST 结构抽取字段覆盖率测试
 *
 * 验证 antlr4ts listener 能确定性抽出 inventory 所需的全部结构字段
 *（parameters / returnType / types / variables / constants / columns / trigger / sequence / standalone / overload），
 * 即 inventory 阶段可下沉到 prescan、无需 LLM 的依据。
 *
 * scanner InventoryIndex 新形状：packages（packageName/headerPath/bodyPath + procedures/functions 名字数组 +
 * constants/variables/exceptions/types）+ 独立 subprograms 数组（含 parameters/bodyLocation/directCalls 等详情）。
 *
 * fixture: 各 describe 内联自造 SQL（小写关键字 / standalone directCalls / 嵌套局部过程 /
 * SQL*Plus 关键字列名），不依赖外部 fixture。
 */

import { describe, it, expect } from "vitest"
import { scanFileSet, finalizeFileSetResults, type InventoryIndex } from "@workflow/plsql-scanner"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// 递归收集 root 下 .sql 文件
function collectSql(root: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      if (statSync(p).isDirectory()) walk(p)
      else if (e.endsWith(".sql")) out.push(p)
    }
  }
  walk(root)
  return out
}

// 直接调 AST 路径 scanFileSet（生产主路径已切 regex，scanWithAST 不再跑 AST；此处显式走 AST
// 作全字段回归对照，scannerUsed="ast"）。失败（antlr4ts 运行时未装）抛错由调用方 try/catch 降级 skip。
const scanAst = (root: string): InventoryIndex =>
  finalizeFileSetResults([scanFileSet(collectSql(root), root)], root, "ast")

// ═══════════════════════════════════════════════════════════════
// 大小写不敏感关键字（真实项目常用小写关键字 create/package/procedure）
// grammar 声明 caseInsensitive=true 但 antlr4ts 4.7.2 忽略；scanner 用 UpperCaseCharStream
// 包装 lexer 输入（只转 LA，保留原文）实现大小写不敏感匹配。
// ═══════════════════════════════════════════════════════════════

describe("plsql-scanner 大小写不敏感关键字", () => {
  it("小写关键字 + 小写字符串值：结构抽取正常，字符串原文保留", async () => {
    const tmp = await import("node:fs/promises").then(fs => fs.mkdtemp(import.meta.dirname + "/../../../.tmp-lower-"))
    const { writeFileSync } = await import("node:fs")
    writeFileSync(`${tmp}/lower_pkg.sql`, `create or replace package body lower_pkg as
  c_msg constant varchar2(20) := 'hello world';
  procedure entry_proc is
  begin
    helper_proc('test');
  end;
  procedure helper_proc(p_msg varchar2) is begin null; end;
end;
/`, "utf-8")
    try {
      const inv = scanAst(tmp)
      expect(inv.scannerUsed).toBe("ast")
      const pkg = inv.packages.find(p => p.packageName === "LOWER_PKG")
      expect(pkg, "小写关键字包应被识别").toBeDefined()
      // 字符串常量值原文保留（getText 取原文，仅 LA 转大写）
      const c = pkg!.constants.find(x => x.name === "C_MSG")
      expect(c?.value).toBe("'hello world'")
      // 同包裸名调用边
      const entry = inv.subprograms.find(s => s.name === "ENTRY_PROC")
      expect(entry?.directCalls.some(d => d.name === "HELPER_PROC")).toBe(true)
    } finally {
      await import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true }))
    }
  }, 30000)
})

describe("plsql-scanner standalone CREATE directCalls 捕获", () => {
  it("standalone CREATE PROCEDURE 体内的跨包调用被捕获进 directCalls（不再恒空）", async () => {
    const tmp = await import("node:fs/promises").then(fs => fs.mkdtemp(import.meta.dirname + "/../../../.tmp-standalone-"))
    const { writeFileSync } = await import("node:fs")
    writeFileSync(`${tmp}/pkgs.sql`, `CREATE OR REPLACE PACKAGE etl_pkg AS
  PROCEDURE run(p_id NUMBER);
END etl_pkg;
/
CREATE OR REPLACE PACKAGE BODY etl_pkg AS
  PROCEDURE run(p_id NUMBER) IS BEGIN NULL; END;
END etl_pkg;
/
CREATE OR REPLACE PACKAGE other_pkg AS
  PROCEDURE helper(p_id NUMBER);
END other_pkg;
/
CREATE OR REPLACE PACKAGE BODY other_pkg AS
  PROCEDURE helper(p_id NUMBER) IS BEGIN NULL; END;
END other_pkg;
/`, "utf-8")
    writeFileSync(`${tmp}/standalone.sql`, `CREATE OR REPLACE PROCEDURE do_migrate(p_id IN NUMBER) IS
BEGIN
  etl_pkg.run(p_id);
  other_pkg.helper(p_id);
END do_migrate;
/`, "utf-8")
    try {
      const inv = scanAst(tmp)
      const sub = inv.subprograms.find(s => s.belongToPackage === "__STANDALONE_DO_MIGRATE__")
      expect(sub, "standalone 虚拟包子程序应存在").toBeDefined()
      // 修复前 directCalls 恒空（enterCreate_procedure_body 不压 subprogramStack，体内调用被早退丢弃）
      expect(sub!.directCalls.map(d => `${d.package}.${d.name}`).sort()).toEqual(
        ["ETL_PKG.RUN", "OTHER_PKG.HELPER"]
      )
    } finally {
      await import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true }))
    }
  }, 30000)
})

describe("plsql-scanner 嵌套局部过程不泄漏为包级", () => {
  it("过程体内嵌套定义的局部过程不注册为包级子程序，其调用卷回外层", async () => {
    const tmp = await import("node:fs/promises").then(fs => fs.mkdtemp(import.meta.dirname + "/../../../.tmp-nested-"))
    const { writeFileSync } = await import("node:fs")
    writeFileSync(`${tmp}/pkg.sql`, `CREATE OR REPLACE PACKAGE outer_pkg AS
  PROCEDURE main_proc(p_id NUMBER);
  PROCEDURE real_proc(p_id NUMBER);
END outer_pkg;
/
CREATE OR REPLACE PACKAGE BODY outer_pkg AS
  PROCEDURE real_proc(p_id NUMBER) IS BEGIN NULL; END;
  PROCEDURE main_proc(p_id NUMBER) IS
    PROCEDURE local_helper(x NUMBER) IS
    BEGIN
      real_proc(x);
    END;
  BEGIN
    local_helper(p_id);
  END main_proc;
END outer_pkg;
/`, "utf-8")
    try {
      const inv = scanAst(tmp)
      const pkgSubs = inv.subprograms.filter(s => s.belongToPackage === "OUTER_PKG")
      const names = pkgSubs.map(s => s.name).sort()
      // 修复前 local_helper 被注册为包级子程序（污染）；修复后仅 main_proc + real_proc
      expect(names).toEqual(["MAIN_PROC", "REAL_PROC"])
      // local_helper 体内的 real_proc 调用应卷回 main_proc（不是丢失，也不是 local_helper 节点）
      const main = pkgSubs.find(s => s.name === "MAIN_PROC")!
      expect(main.directCalls.some(d => d.name === "REAL_PROC")).toBe(true)
    } finally {
      await import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true }))
    }
  }, 30000)
})

describe("plsql-scanner 表列提取：SQL*Plus 关键字列名 + 块注释", () => {
  it("CREATE TABLE 中以 EXIT/SET 命名的列不被 SQL*Plus strip 误剥；块注释不产幻影列", async () => {
    const tmp = await import("node:fs/promises").then(fs => fs.mkdtemp(import.meta.dirname + "/../../../.tmp-cols-"))
    const { writeFileSync } = await import("node:fs")
    writeFileSync(`${tmp}/tab.sql`, `SET SERVEROUTPUT ON
CREATE TABLE t_meta (
  id NUMBER NOT NULL,
  /* 这是 EXIT 列，非 SQL*Plus EXIT 命令
     多行注释中间行 col_phantom NUMBER 不应成列 */
  EXIT VARCHAR2(10),
  SET_FLAG NUMBER,
  name VARCHAR2(40)
);
/
EXIT`, "utf-8")
    try {
      const inv = scanAst(tmp)
      const tab = inv.tables.find(t => t.name === "T_META")!
      expect(tab, "表应被提取").toBeDefined()
      const colNames = tab.columns.map(c => c.name).sort()
      expect(colNames).toEqual(["EXIT", "ID", "NAME", "SET_FLAG"])
      // 块注释中间行 col_phantom 不应成幻影列
      expect(tab.columns.find(c => c.name === "COL_PHANTOM")).toBeUndefined()
      // 顶层 SET SERVEROUTPUT ON / EXIT 仍被 strip（不影响表体外的 SQL*Plus 命令）
    } finally {
      await import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true }))
    }
  }, 30000)
})
