/**
 * find-all-subprograms.test.ts — findAllSubprograms 状态机测试
 *
 * regex 主路径（无 AST）识别包级子程序，过滤嵌套局部过程。字符串/注释/括号深度感知。
 */

import { describe, it, expect } from "vitest"
import { findAllSubprograms } from "@workflow/plsql-file-scanner"

const BODY = `CREATE OR REPLACE PACKAGE BODY MFG_ERP.P_FOO IS
  PROCEDURE do_work(p IN NUMBER) IS
  BEGIN
    NULL;
  END do_work;
  FUNCTION get_val RETURN NUMBER IS
    v NUMBER;
  BEGIN
    RETURN v;
  END get_val;
END P_FOO;
`

describe("findAllSubprograms 包级子程序识别", () => {
  it("抽得包级 PROCEDURE + FUNCTION（body 实现，含行号区间）", () => {
    const subs = findAllSubprograms(BODY)
    expect(subs).toEqual([
      { name: "DO_WORK", type: "PROCEDURE", startLine: 2, endLine: 5, kind: "body", pkgName: "MFG_ERP.P_FOO" },
      { name: "GET_VAL", type: "FUNCTION", startLine: 6, endLine: 10, kind: "body", pkgName: "MFG_ERP.P_FOO" },
    ])
  })

  it("过滤嵌套局部过程：只抽外层 outer，不抽 inner", () => {
    const code = `CREATE OR REPLACE PACKAGE BODY P_FOO IS
  PROCEDURE outer IS
    PROCEDURE inner IS
    BEGIN
      NULL;
    END inner;
  BEGIN
    NULL;
  END outer;
END P_FOO;
`
    const subs = findAllSubprograms(code)
    expect(subs).toEqual([{ name: "OUTER", type: "PROCEDURE", startLine: 2, endLine: 9, kind: "body", pkgName: "P_FOO" }])
  })

  it("spec 文件分号声明 → kind=header，区间为声明行", () => {
    const spec = `CREATE OR REPLACE PACKAGE P_FOO IS
  PROCEDURE do_work(p IN NUMBER);
  FUNCTION get_val RETURN NUMBER;
END P_FOO;
`
    const subs = findAllSubprograms(spec)
    expect(subs).toEqual([
      { name: "DO_WORK", type: "PROCEDURE", startLine: 2, endLine: 2, kind: "header", pkgName: "P_FOO" },
      { name: "GET_VAL", type: "FUNCTION", startLine: 3, endLine: 3, kind: "header", pkgName: "P_FOO" },
    ])
  })

  it("字符串 / 注释内的 PROCEDURE 不误判", () => {
    const code = `CREATE OR REPLACE PACKAGE P_FOO IS
  -- PROCEDURE commented(p NUMBER);
  v VARCHAR2(100) := 'PROCEDURE fake(p NUMBER);';
  PROCEDURE real_proc;
END P_FOO;
`
    const subs = findAllSubprograms(code)
    expect(subs.map(s => s.name)).toEqual(["REAL_PROC"])
  })

  it("END IF / END LOOP / END CASE 不误弹子程序栈", () => {
    const code = `CREATE OR REPLACE PACKAGE BODY P_FOO IS
  PROCEDURE p IS
  BEGIN
    IF TRUE THEN NULL; END IF;
    FOR i IN 1..3 LOOP NULL; END LOOP;
  END p;
END P_FOO;
`
    const subs = findAllSubprograms(code)
    expect(subs).toEqual([{ name: "P", type: "PROCEDURE", startLine: 2, endLine: 6, kind: "body", pkgName: "P_FOO" }])
  })

  it("重载同名子程序按序抽多条", () => {
    const code = `CREATE OR REPLACE PACKAGE P_FOO IS
  PROCEDURE ov(p NUMBER);
  PROCEDURE ov(p VARCHAR2);
END P_FOO;
`
    const subs = findAllSubprograms(code)
    expect(subs.length).toBe(2)
    expect(subs.every(s => s.name === "OV")).toBe(true)
    expect(subs.map(s => s.startLine)).toEqual([2, 3])
  })

  it("包级初始化块 BEGIN...END pkg; 不误判为子程序", () => {
    const code = `CREATE OR REPLACE PACKAGE BODY P_FOO IS
  g_count NUMBER := 0;
  PROCEDURE bump IS
  BEGIN
    g_count := g_count + 1;
  END bump;
BEGIN
  g_count := 0;
END P_FOO;
`
    const subs = findAllSubprograms(code)
    expect(subs.map(s => s.name)).toEqual(["BUMP"])  // 包级 init 块不算子程序
  })

  it("参数列表内的 ;/IS/END 不计（括号深度感知）", () => {
    const code = `CREATE OR REPLACE PACKAGE P_FOO IS
  PROCEDURE tricky(p VARCHAR2 := 'a; b IS END;') ;
END P_FOO;
`
    const subs = findAllSubprograms(code)
    expect(subs).toEqual([{ name: "TRICKY", type: "PROCEDURE", startLine: 2, endLine: 2, kind: "header", pkgName: "P_FOO" }])
  })
})
