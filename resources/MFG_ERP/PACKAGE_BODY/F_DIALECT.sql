-- F_DIALECT.sql — GaussDB/openGauss 方言构造回归基线
--
-- 用途：集中放 PL/SQL grammar 不支持的 GaussDB 方言构造，作为 grammar 增强的回归基线。
--   当前（grammar 未增强）跑 parseFileAst 应报语法错误 + 漏抽 ::/LIMIT 之后的调用；
--   grammar 补 limit_clause / GET DIAGNOSTICS / :: 类型转换后，应 0 语法错误 +
--   每个过程的 helper_ok / F_UTIL.f_log 调用都不漏抽 + 所有过程都被识别。
--
-- 设计要点：
--   1. 每个方言构造后紧跟 helper_ok（本包）+ F_UTIL.f_log（跨包）——验证错误恢复不吞调用；
--   2. 多个过程并列 ——验证 :: 这类结构性错误不级联吞掉后续过程声明（p_limit/p_diag/p_no_from 都要被识别）；
--   3. p_no_from 是正向用例（grammar 已支持无 FROM 的 SELECT），防 grammar 改动回归。
CREATE OR REPLACE PACKAGE BODY MFG_ERP.F_DIALECT AS

  -- 本包调用目标（确保 directCalls 有已知 callee，post-filter 保留）
  PROCEDURE helper_ok IS
  BEGIN
    NULL;
  END helper_ok;

  -- 1. :: 类型转换（GaussDB PG 风格，PL/SQL 用 CAST）——结构性致命，验证不级联吞后续过程
  PROCEDURE p_cast IS
    v INTEGER;
  BEGIN
    SELECT '100' :: INTEGER INTO v FROM DUAL;
    helper_ok;
    F_UTIL.f_log('cast');
  END p_cast;

  -- 2. LIMIT 分页（GaussDB/MySQL 风格，PL/SQL 用 ROWNUM / FETCH FIRST）
  PROCEDURE p_limit IS
    v INTEGER;
  BEGIN
    SELECT count(1)
      INTO v
      FROM (SELECT t.x
              FROM some_table t
             WHERE t.y = 1
             ORDER BY t.x DESC
             LIMIT 1);
    helper_ok;
    F_UTIL.f_log('limit');
  END p_limit;

  -- 2b. LIMIT n OFFSET m
  PROCEDURE p_limit_offset IS
    v INTEGER;
  BEGIN
    SELECT count(1) INTO v FROM some_table LIMIT 10 OFFSET 20;
    helper_ok;
    F_UTIL.f_log('limit_offset');
  END p_limit_offset;

  -- 3. GET DIAGNOSTICS var = ROW_COUNT（openGauss 过程语句，PL/SQL 用 SQL%ROWCOUNT）
  PROCEDURE p_diag IS
    v INTEGER;
  BEGIN
    UPDATE some_table SET x = 1 WHERE y = 2;
    GET DIAGNOSTICS v = ROW_COUNT;
    helper_ok;
    F_UTIL.f_log('diag');
  END p_diag;

  -- 4. 缺 FROM DUAL（GaussDB 允许，grammar 的 from_clause? 已可选）——正向用例防回归
  PROCEDURE p_no_from IS
    v INTEGER;
  BEGIN
    SELECT 1 + 1 INTO v;
    helper_ok;
    F_UTIL.f_log('no_from');
  END p_no_from;

  -- 5. || 作逻辑或（项目代码非标准写法，用 || 代 OR）
  --    与字符串拼接的 || 靠操作数层级区分：拼接走 concatenation，逻辑或走 logical_expression
  PROCEDURE p_logical_or IS
    v VARCHAR2(10);
    n INTEGER;
  BEGIN
    v := 'a' || 'b';                 -- 字符串拼接（concatenation）
    IF v IS NULL || v = '1' THEN     -- || 逻辑或（IS NULL || 比较）
      helper_ok;
    END IF;
    IF n = 1 || n = 2 THEN           -- || 逻辑或（比较 || 比较）
      helper_ok;
    END IF;
  END p_logical_or;

  -- 6. 数组类型 int[] 声明 + v[1] 索引（GaussDB 数组）
  --    type_spec 加数组维度后缀 ['[' UNSIGNED_INTEGER? ']']*；v[1] 索引走 model_expression
  PROCEDURE p_array IS
    v INTEGER[];
    w INTEGER;
  BEGIN
    v := ARRAY[1, 2, 3];
    w := v[1];
    helper_ok;
  END p_array;

  -- 7. 美元引用字符串 $$...$$ / $tag$...$tag$（可跨行、含引号），lexer 作 CHAR_STRING 返回
  PROCEDURE p_dollar IS
    v VARCHAR2(100);
  BEGIN
    v := $$hello world$$;
    v := $tag$it's ok$tag$;
    helper_ok;
  END p_dollar;

  -- 8. 无参过程/函数空括号 PROCEDURE p()（openGauss 方言，PL/SQL 写 PROCEDURE p 无括号）
  --    spec/body/standalone 的 parameter 列表改为允许空 ()
  PROCEDURE p_empty_paren() IS
  BEGIN
    helper_ok();
  END p_empty_paren;

END F_DIALECT;
