/**
 * locate-subprogram-range.test.ts — locateSubprogramRange 单测
 *
 * 验证 regex 锚定 + END 收窄法在包体/包头文本里定位子程序 lineRange：
 * 正常过程/函数、END 省名、嵌套 BEGIN/END IF/END LOOP 不干扰、重载第 N 个、
 * spec 声明无 END 退路、大小写不敏感、找不到返回 null。
 * 这是 inventory 落盘前补齐 AST 漏抽 bodyLocation/headerLocation 的兜底依据。
 */

import { describe, it, expect } from "vitest"
import { locateSubprogramRange } from "@workflow/plsql-file-scanner"

const BODY = `CREATE OR REPLACE PACKAGE BODY pkg IS
  v_global NUMBER;
  PROCEDURE transfer_money(p1 IN NUMBER, p2 OUT VARCHAR2) IS
    v_bal NUMBER;
  BEGIN
    UPDATE accounts SET bal = bal - p1 WHERE id = 1;
    IF p1 > 0 THEN
      p2 := 'ok';
    END IF;
  EXCEPTION
    WHEN OTHERS THEN p2 := 'err';
  END transfer_money;

  FUNCTION get_balance(id IN NUMBER) RETURN NUMBER IS
    v_ret NUMBER;
  BEGIN
    FOR r IN (SELECT bal FROM accounts WHERE id = id) LOOP
      v_ret := r.bal;
    END LOOP;
    RETURN v_ret;
  END get_balance;
END pkg;
`

const OVERLOAD = `CREATE OR REPLACE PACKAGE BODY opkg IS
  PROCEDURE foo(a IN NUMBER) IS
  BEGIN
    NULL;
  END;
  PROCEDURE foo(a IN VARCHAR2) IS
  BEGIN
    NULL;
  END foo;
END opkg;
`

const SPEC = `CREATE OR REPLACE PACKAGE spkg IS
  PROCEDURE foo(p1 IN NUMBER);
  FUNCTION bar RETURN NUMBER;
END spkg;
`

describe("locateSubprogramRange", () => {
  it("PROCEDURE body：start=声明行，end=END name; 行（嵌套 END IF/EXCEPTION 不干扰）", () => {
    const r = locateSubprogramRange(BODY, "pkg", "TRANSFER_MONEY", "PROCEDURE", null)
    expect(r).toEqual({ lineRange: [3, 12] })
  })

  it("FUNCTION body：含 FOR/END LOOP 嵌套，end=END name; 行", () => {
    const r = locateSubprogramRange(BODY, "pkg", "GET_BALANCE", "FUNCTION", null)
    expect(r).toEqual({ lineRange: [14, 21] })
  })

  it("END 省名（END;）也能匹配", () => {
    const r = locateSubprogramRange(OVERLOAD, "opkg", "FOO", "PROCEDURE", 1)
    expect(r).toEqual({ lineRange: [2, 5] })
  })

  it("重载第 2 个：取第 2 个声明，end=END name; 行", () => {
    const r = locateSubprogramRange(OVERLOAD, "opkg", "FOO", "PROCEDURE", 2)
    expect(r).toEqual({ lineRange: [6, 9] })
  })

  it("spec（header）声明无 END：end 退到下一个顶层声明前一行", () => {
    const r = locateSubprogramRange(SPEC, "spkg", "FOO", "PROCEDURE", null)
    expect(r).toEqual({ lineRange: [2, 2] })
  })

  it("spec 最后一个子程序：end 退到包 END 前", () => {
    const r = locateSubprogramRange(SPEC, "spkg", "BAR", "FUNCTION", null)
    expect(r).toEqual({ lineRange: [3, 3] })
  })

  it("大小写不敏感：源码小写/混合写，name 传入大写也能匹配", () => {
    const mixed = `CREATE OR REPLACE PACKAGE BODY pkg IS
  procedure Do_Something IS
  begin
    null;
  end Do_Something;
END pkg;
`
    const r = locateSubprogramRange(mixed, "pkg", "DO_SOMETHING", "PROCEDURE", null)
    expect(r).toEqual({ lineRange: [2, 5] })
  })

  it("找不到声明返回 null", () => {
    const r = locateSubprogramRange(BODY, "pkg", "NONEXISTENT", "PROCEDURE", null)
    expect(r).toBeNull()
  })

  it("overloadIndex 超出实际重载数返回 null", () => {
    const r = locateSubprogramRange(OVERLOAD, "opkg", "FOO", "PROCEDURE", 3)
    expect(r).toBeNull()
  })
})
