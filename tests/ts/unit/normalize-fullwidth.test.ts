/**
 * normalize-fullwidth.test.ts — 全角语法符号归一化器单元测试
 *
 * 验证 parse 前的全角→半角归一化：SQL 代码区的全角语法符号转半角，
 * 字符串字面量/引号标识符/注释内的所有字符原样保留。所有替换 1:1，
 * 长度与 offset 对齐。
 */

import { describe, it, expect } from "vitest"
import { normalizeFullwidthSyntax } from "@workflow/plsql-file-scanner"

describe("normalizeFullwidthSyntax", () => {
  it("全角引号边界 + 串内全角逗号原样保留", () => {
    expect(normalizeFullwidthSyntax(`v := ‘数据，耗时’;`)).toBe(`v := '数据，耗时';`)
  })

  it("串外全角分号/括号转半角，串内全角分号保留", () => {
    const out = normalizeFullwidthSyntax(`p（a；b；）返回‘x；y’；`)
    expect(out).toBe(`p(a;b;)返回'x；y';`)
  })

  it("q-quote 内含全角逗号原样保留", () => {
    expect(normalizeFullwidthSyntax(`v := q'[数据，耗时]';`)).toBe(`v := q'[数据，耗时]';`)
  })

  it("q-quote 内容中含分隔符不误结束", () => {
    // 分隔符 ( 配对 )；内容 a)b 里的 ) 不结束，到 )' 才结束
    expect(normalizeFullwidthSyntax(`v := q'(a)b)';`)).toBe(`v := q'(a)b)';`)
  })

  it("行注释内全角字符原样保留", () => {
    const out = normalizeFullwidthSyntax(`-- 注释；含全角（）\nv := 'x';`)
    expect(out).toBe(`-- 注释；含全角（）\nv := 'x';`)
  })

  it("块注释内全角字符原样保留", () => {
    expect(normalizeFullwidthSyntax(`/* 块（；）*/ v := 'x';`)).toBe(`/* 块（；）*/ v := 'x';`)
  })

  it("双引号标识符内原样保留", () => {
    expect(normalizeFullwidthSyntax(`“表名，数据”`)).toBe(`"表名，数据"`)
  })

  it("'' 转义不被破坏（含全角连续）", () => {
    expect(normalizeFullwidthSyntax(`v := 'it''s';`)).toBe(`v := 'it''s';`)
    expect(normalizeFullwidthSyntax(`v := ‘it’’s’;`)).toBe(`v := 'it''s';`)
  })

  it("纯 ASCII 合法文件幂等（不变）", () => {
    const src = `create or replace package body P is\n  procedure x is begin v := 'data,cost'; end;\nend;\n/`
    expect(normalizeFullwidthSyntax(src)).toBe(src)
  })

  it("1:1 替换：长度与串内全角逗号 offset 对齐", () => {
    const src = `v := ‘数据，耗时’;`
    const out = normalizeFullwidthSyntax(src)
    expect(out.length).toBe(src.length)
    expect(out.indexOf("，")).toBe(src.indexOf("，"))
  })

  it("全角运算符/等号/冒号转半角", () => {
    expect(normalizeFullwidthSyntax(`v：＝1＋2＊3；`)).toBe(`v:=1+2*3;`)
  })
})
