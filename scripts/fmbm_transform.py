#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 resources/mfg_erp_sql 按 FMBM 规约重新生成到 icbc/MFG_ERP/。

规约要点（决策见 plans/peaceful-wiggling-chipmunk.md）：
- 目录: PACKAGE / PACKAGE_BODY / TYPE / TABLE
- 包名: inventory_pkg -> F_INVENTORY (去 _pkg、大写、F_ 前缀)；跨包调用 xxx_pkg. -> F_XXX.
- schema 前缀 MFG_ERP. 只加在 CREATE 语句上
- 参数匈牙利改名(全量, 含 4 个分歧名, 带 callee 解析)；局部变量不改；不造参数行尾注释
- GRANT 丢弃(源本就没有)
- 嵌套私有过程(walk/add_demand)不在 spec, 保持原名一致, 不影响 Java 转译
- 样本瑕疵不照抄
"""
import re
import sys
from pathlib import Path

SRC = Path('resources/mfg_erp_sql')
OUT = Path('resources/MFG_ERP')
SCHEMA = 'MFG_ERP'
AUTHOR = 'sql2java-workflow'
CREATED = '2026-07-03'

# ---- 包名映射 ----
PKG_OLD = sorted(p.stem[:-4] for p in (SRC / 'pkg').glob('*.sql'))  # ['bom','const',...]
PKG_OLD_FULL = [f'{b}_pkg' for b in PKG_OLD]  # ['bom_pkg',...]
# settle_pkg 在源里被调用但无定义, 仍改写为 F_SETTLE(悬空)
PKG_OLD_FULL.append('settle_pkg')
OLD_TO_NEW = {}
for b in PKG_OLD:
    OLD_TO_NEW[f'{b}_pkg'] = f'F_{b.upper()}'
OLD_TO_NEW['settle_pkg'] = 'F_SETTLE'

# ---- tokenizer ----
TOKEN_RE = re.compile(r"""
  (?P<ws>[ \t\r\n]+)
| (?P<linecomment>--[^\n]*)
| (?P<blockcomment>/\*.*?\*/)
| (?P<string>'(?:''|[^'])*')
| (?P<num>\d[\d.]*)
| (?P<ident>[A-Za-z_][A-Za-z0-9_$#]*)
| (?P<op>=>|:=|\|\||<=|>=|<>|!=|\.\.)
| (?P<punct>[(),.;])
| (?P<other>.)
""", re.X | re.S)


def tokenize(text):
    toks = []
    pos = 0
    while pos < len(text):
        m = TOKEN_RE.match(text, pos)
        if not m:
            toks.append(('other', text[pos]))
            pos += 1
            continue
        kind = m.lastgroup
        toks.append((kind, m.group()))
        pos = m.end()
    return toks


def detok(toks):
    return ''.join(t[1] for t in toks)


def next_non_ws(toks, i):
    j = i
    while j < len(toks) and toks[j][0] == 'ws':
        j += 1
    return j if j < len(toks) else None


def prev_non_ws(toks, i):
    j = i - 1
    while j >= 0 and toks[j][0] == 'ws':
        j -= 1
    return j if j >= 0 else None


# ---- 类型/方向 -> 匈牙利前缀 ----
def norm_type(raw):
    r = raw.upper().strip()
    if 'SYS_REFCURSOR' in r:
        return 'refcursor'
    if r.startswith(('VARCHAR2', 'CHAR', 'CLOB', 'NVARCHAR2', 'NCHAR', 'NCLOB')):
        return 'string'
    if r.startswith('NUMBER') or r.startswith('INTEGER') or r.startswith('BINARY') or r.startswith('PLS_INTEGER'):
        return 'number'
    if r.startswith(('DATE', 'TIMESTAMP')):
        return 'date'
    if r.startswith('BOOLEAN'):
        return 'bool'
    return 'table'  # %ROWTYPE / %TYPE / t_xxx / 自定义


DIR_LETTER = {'IN': 'i', 'OUT': 'o', 'IO': 'io'}
TYPE_LETTER = {'string': 's', 'number': 'i', 'date': 'd',
               'refcursor': 'r', 'table': 't', 'bool': 'b'}


def hungarian(old, direction, ntype):
    d = DIR_LETTER[direction]
    t = TYPE_LETTER[ntype]
    pre = (d + t + '_') if d != 'io' else ('io' + t + '_')
    name = old[2:] if old.startswith('p_') else old
    return pre + name


# ---- 参数串解析(深度感知逗号) ----
def split_params(params_str):
    parts = []
    depth = 0
    cur = ''
    for ch in params_str:
        if ch == '(':
            depth += 1
            cur += ch
        elif ch == ')':
            depth -= 1
            cur += ch
        elif ch == ',' and depth == 0:
            parts.append(cur)
            cur = ''
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return parts


PARAM_RE = re.compile(
    r'^\s*(\w+)\s+(IN\s+OUT|IN|OUT)\s+(NOCOPY\s+)?(.*?)(\s+DEFAULT\s+.*)?$\s*',
    re.I | re.S)


def parse_params(params_str):
    """返回 [(old, direction, ntype, new)]。direction: IN/OUT/IO"""
    out = []
    for part in split_params(params_str):
        part = part.strip()
        if not part:
            continue
        m = PARAM_RE.match(part)
        if not m:
            # 可能是无方向的自定义类型参数(t_recv_tab 等)或仅游标, 跳过改名
            continue
        name = m.group(1)
        d = m.group(2).upper().replace(' ', '')
        d = 'IO' if d == 'INOUT' else d
        typ_raw = (m.group(4) or '').strip()
        # 截到类型本体(去掉尾巴)
        ntype = norm_type(typ_raw)
        out.append((name, d, ntype, hungarian(name, d, ntype)))
    return out


# ---- 签名扫描(深度感知括号) ----
def find_signatures(text):
    """找 PROCEDURE/FUNCTION 签名: 返回 [(start, end, kind, name, params_str)]。
    end 是参数右括号后的位置(含)。仅捕获 name 后紧跟 (...) 的形式。"""
    toks = tokenize(text)
    res = []
    i = 0
    n = len(toks)
    while i < n:
        kind, txt = toks[i]
        if kind == 'ident' and txt.upper() in ('PROCEDURE', 'FUNCTION'):
            # 跳过 MEMBER / OVERRIDING 等前缀已在前面, 这里 name 是下一个 ident
            j = next_non_ws(toks, i + 1)
            if j is None or toks[j][0] != 'ident':
                i += 1
                continue
            name = toks[j][1]
            k = next_non_ws(toks, j + 1)
            if k is None or toks[k] != ('punct', '('):
                i = j + 1
                continue
            # 深度感知找匹配 )
            depth = 1
            p = k + 1
            while p < n and depth > 0:
                tk = toks[p]
                if tk == ('punct', '('):
                    depth += 1
                elif tk == ('punct', ')'):
                    depth -= 1
                p += 1
            # params 位置: k+1 .. p-1
            params_str = detok(toks[k + 1:p - 1])
            start = i  # token index
            res.append({'tok_start': i, 'tok_end': p,
                        'kind': txt.lower(), 'name': name, 'params': params_str})
            i = p
            continue
        i += 1
    # 转回字符偏移需要重算; 这里直接返回 token 索引版, 由调用方在 token 域操作
    return res, toks


# ---- 全局 formal 映射(从 spec) ----
# formal_map[(new_pkg, proc)] = [ {'old_new': {old:new}, 'old_set': set, 'list':[(old,new,..)] } ]
def build_formal_map(all_specs):
    fmap = {}
    for pkg_old, spec_text in all_specs.items():
        new_pkg = OLD_TO_NEW[pkg_old + '_pkg']
        sigs, _ = find_signatures(spec_text)
        for s in sigs:
            params = parse_params(s['params'])
            entry = {
                'old_new': {p[0]: p[3] for p in params},
                'old_set': set(p[0] for p in params),
                'new_set': set(p[3] for p in params),
                'list': params,
            }
            fmap.setdefault((new_pkg, s['name']), []).append(entry)
    return fmap


# ---- 跨包改写(整文件级, word boundary, 含字符串/注释) ----
def cross_pkg_rewrite(text):
    for old in sorted(OLD_TO_NEW, key=len, reverse=True):
        text = re.sub(r'\b' + re.escape(old) + r'\b', OLD_TO_NEW[old], text)
    return text


# ---- schema 前缀 ----
def add_schema_prefix_pkg_spec(text):
    return re.sub(r'CREATE OR REPLACE PACKAGE (\w+) AS',
                  r'CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE ' + SCHEMA + r'.\1 IS', text, count=1)


def add_schema_prefix_pkg_body(text):
    return re.sub(r'CREATE OR REPLACE PACKAGE BODY (\w+) AS',
                  r'CREATE OR REPLACE /*EDITIONABLE*/ PACKAGE BODY ' + SCHEMA + r'.\1 AS', text, count=1)


def add_schema_prefix_type(text):
    text = re.sub(r'CREATE OR REPLACE TYPE (BODY )?(\w+)',
                  lambda m: 'CREATE OR REPLACE TYPE ' + (m.group(1) or '') + SCHEMA + '.' + m.group(2),
                  text)
    return text


def add_schema_prefix_table(text):
    def rep(m):
        return 'CREATE ' + (m.group(1) or '') + m.group(2) + ' ' + SCHEMA + '.' + m.group(3)
    return re.sub(r'CREATE (UNIQUE )?(TABLE|SEQUENCE|VIEW|INDEX) (\w+)', rep, text)


# ---- 命名调用点 key => 改写(token 域, 含字符串递归) ----
def resolve_overload(entries, keys_set):
    """返回匹配的 entry 或 None"""
    if not entries:
        return None
    cands = [e for e in entries if keys_set <= e['old_set']]
    if not cands:
        return None
    # 最小 formal 集 = 最具体
    cands.sort(key=lambda e: len(e['old_set']))
    return cands[0]


def rewrite_keys(text, current_pkg_new, fmap):
    toks = tokenize(text)
    n = len(toks)
    # 框架栈: 每个 open '(' 一个 frame
    # frame = {'callee': (pkg,proc)|None, 'keys': [(tok_idx, oldkey)]}
    stack = []
    i = 0
    while i < n:
        kind, txt = toks[i]
        if kind == 'string' and '=>' in txt:
            # 动态 SQL: 递归处理字符串内容
            inner = txt[1:-1].replace("''", "'")
            inner2 = rewrite_keys(inner, current_pkg_new, fmap)
            inner2 = inner2.replace("'", "''")
            toks[i] = ('string', "'" + inner2 + "'")
            i += 1
            continue
        if kind == 'punct' and txt == '(':
            # 判定 callee: 前一个非ws token 是否 ident, 再前是否 ident('pkg.proc')
            p1 = prev_non_ws(toks, i)
            callee = None
            if p1 is not None and toks[p1][0] == 'ident':
                p0 = prev_non_ws(toks, p1)
                if p0 is not None and toks[p0] == ('punct', '.'):
                    pm1 = prev_non_ws(toks, p0)
                    if pm1 is not None and toks[pm1][0] == 'ident':
                        callee = (toks[pm1][1], toks[p1][1])
                else:
                    callee = (current_pkg_new, toks[p1][1])
            stack.append({'callee': callee, 'keys': []})
            i += 1
            continue
        if kind == 'punct' and txt == ')':
            if stack:
                frame = stack.pop()
                callee = frame['callee']
                if callee is not None and callee in fmap and frame['keys']:
                    keys_set = set(k for _, k in frame['keys'])
                    entry = resolve_overload(fmap[callee], keys_set)
                    if entry:
                        for tidx, oldkey in frame['keys']:
                            if oldkey in entry['old_new']:
                                toks[tidx] = ('ident', entry['old_new'][oldkey])
            i += 1
            continue
        if kind == 'ident':
            # 是否为命名键: 后一个非ws token 是 '=>'
            j = next_non_ws(toks, i + 1)
            if j is not None and toks[j] == ('op', '=>') and stack:
                stack[-1]['keys'].append((i, txt))
            i += 1
            continue
        i += 1
    return detok(toks)


# ---- 顶层单位切分(包体) ----
TOPUNIT_RE = re.compile(r'^    (PROCEDURE|FUNCTION) (\w+)', re.M)


def split_body_units(body_text):
    """返回 [(start, end, name)] 顶层单位区间(字符偏移)。end 到下一个单位起点或 body 末尾。"""
    matches = list(TOPUNIT_RE.finditer(body_text))
    units = []
    for idx, m in enumerate(matches):
        start = m.start()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(body_text)
        units.append((start, end, m.group(2)))
    return units


# ---- 单位内 formal 改名(值引用 + 签名声明) ----
def rewrite_unit_values(unit_text):
    """解析单位首个签名的 formals -> old:new, 在单位内整词替换 ident(跳过字符串/注释/命名键)。"""
    sigs, toks = find_signatures(unit_text)
    if not sigs:
        return unit_text
    first = sigs[0]
    params = parse_params(first['params'])
    if not params:
        return unit_text
    old_new = {p[0]: p[3] for p in params}
    for i, (kind, txt) in enumerate(toks):
        if kind != 'ident' or txt not in old_new:
            continue
        j = next_non_ws(toks, i + 1)
        if j is not None and toks[j] == ('op', '=>'):
            continue  # 命名键, 已由 rewrite_keys 处理(或属私有过程保持原名)
        toks[i] = ('ident', old_new[txt])
    return detok(toks)


# ---- spec 签名 formal 改名 ----
def rewrite_spec_signatures(spec_text):
    sigs, toks = find_signatures(spec_text)
    # 每个 signature 在 token 域 [tok_start, tok_end) 内, 用自己的 old_new 改名
    # 从后往前改避免偏移问题(token 域无偏移, 直接改)
    for s in sigs:
        params = parse_params(s['params'])
        old_new = {p[0]: p[3] for p in params}
        if not old_new:
            continue
        for i in range(s['tok_start'], s['tok_end']):
            kind, txt = toks[i]
            if kind == 'ident' and txt in old_new:
                toks[i] = ('ident', old_new[txt])
    return detok(toks)


# ---- 注释: 文件首部 Purpose ----
def extract_purpose(text):
    """取 CREATE 之前的 -- 注释块作为 Purpose"""
    m = re.search(r'CREATE OR REPLACE', text)
    head = text[:m.start()] if m else text
    lines = [l[2:].strip() for l in head.splitlines() if l.strip().startswith('--')]
    return ' / '.join(lines) if lines else '(从 mfg_erp_sql 迁移)'


def header_block(purpose):
    return ('\n'
            '    -- Author : ' + AUTHOR + '\n'
            '    -- Created : ' + CREATED + '\n'
            '    -- Purpose : ' + purpose + '\n')


# ---- 功能块注释(每个子程序前) ----
BLOCK_TEMPLATE = """/*****************************************************************
创建作者：{author}
创建日期：{created}
功能描述：{desc}
*****************************************************************/
"""


def insert_block_comments(text, top_indent='    '):
    """在每个顶层 PROCEDURE/FUNCTION 签名前插入 FMBM 功能块注释。
    desc 取签名上方紧邻的 -- 注释行, 无则用过程名。"""
    matches = list(TOPUNIT_RE.finditer(text))
    if not matches:
        return text
    out = []
    last = 0
    for m in matches:
        sig_start = m.start()
        # 向上找紧邻的 -- 注释行
        seg = text[:sig_start]
        lines = seg.splitlines()
        comments = []
        while lines:
            ln = lines[-1].strip()
            if ln.startswith('--'):
                comments.insert(0, ln[2:].strip())
                lines.pop()
            elif ln == '':
                lines.pop()
            else:
                break
        desc = ' / '.join(comments) if comments else m.group(2)
        block = BLOCK_TEMPLATE.format(author=AUTHOR, created=CREATED, desc=desc)
        # 块注释缩进与签名一致
        indented = ''.join(top_indent + l if l else '' for l in block.splitlines(True))
        out.append(text[last:sig_start])
        out.append(indented)
        last = sig_start
    out.append(text[last:])
    return ''.join(out)


# ---- END 收尾小写 ----
def lowercase_end(text, pkg_new):
    return re.sub(r'END\s+' + re.escape(pkg_new) + r'\s*;',
                  'END ' + pkg_new.lower() + ';', text)


# ---- 主转换 ----
def transform():
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'PACKAGE').mkdir(exist_ok=True)
    (OUT / 'PACKAGE_BODY').mkdir(exist_ok=True)
    (OUT / 'TYPE').mkdir(exist_ok=True)
    (OUT / 'TABLE').mkdir(exist_ok=True)

    # 1. 读所有 spec 建 formal_map
    all_specs = {}
    pkg_files = sorted((SRC / 'pkg').glob('*.sql'))
    for pf in pkg_files:
        base = pf.stem[:-4]  # inventory
        src = pf.read_text()
        spec = src.split('CREATE OR REPLACE PACKAGE BODY')[0]
        all_specs[base] = spec
    fmap = build_formal_map(all_specs)

    summary = {'PACKAGE': 0, 'PACKAGE_BODY': 0, 'TYPE': 0, 'TABLE': 0}

    # 2. 处理每个 package
    for pf in pkg_files:
        base = pf.stem[:-4]
        pkg_old_full = base + '_pkg'
        pkg_new = OLD_TO_NEW[pkg_old_full]
        src = pf.read_text()
        has_body = 'CREATE OR REPLACE PACKAGE BODY' in src
        spec = src.split('CREATE OR REPLACE PACKAGE BODY')[0]
        body = src.split('CREATE OR REPLACE PACKAGE BODY')[1] if has_body else ''

        purpose = cross_pkg_rewrite(extract_purpose(spec))

        # --- spec ---
        spec = cross_pkg_rewrite(spec)
        spec = rewrite_spec_signatures(spec)
        spec = add_schema_prefix_pkg_spec(spec)
        spec = lowercase_end(spec, pkg_new)
        # 先插功能块注释(从源 -- 注释提炼), 再插头注释, 避免 header 被首个签名的功能描述吞掉
        spec = insert_block_comments(spec)
        spec = re.sub(r'(CREATE OR REPLACE /\*EDITIONABLE\*/ PACKAGE ' + SCHEMA + r'\.' + pkg_new + r' IS)\n',
                      r'\1' + header_block(purpose), spec, count=1)
        spec = spec.rstrip() + '\n/\n'
        (OUT / 'PACKAGE' / f'{pkg_new}.sql').write_text(spec)
        summary['PACKAGE'] += 1

        # --- body ---
        if has_body:
            body = 'CREATE OR REPLACE PACKAGE BODY' + body
            body = cross_pkg_rewrite(body)
            body = rewrite_keys(body, pkg_new, fmap)
            # 顶层单位值引用改名
            units = split_body_units(body)
            if units:
                new_body = ''
                last = 0
                for s, e, name in units:
                    new_body += body[last:s]
                    new_body += rewrite_unit_values(body[s:e])
                    last = e
                new_body += body[last:]
                body = new_body
            body = add_schema_prefix_pkg_body(body)
            body = lowercase_end(body, pkg_new)
            body = insert_block_comments(body)
            body = body.rstrip() + '\n/\n'
            (OUT / 'PACKAGE_BODY' / f'{pkg_new}.sql').write_text(body)
            summary['PACKAGE_BODY'] += 1

    # 3. TYPE
    for tf in sorted((SRC / 'type').glob('*.sql')):
        src = tf.read_text()
        src = cross_pkg_rewrite(src)
        # type 方法 formal 改名: 对每个 MEMBER FUNCTION/PROCEDURE 签名+方法体作用域
        src = rewrite_type_methods(src)
        src = add_schema_prefix_type(src)
        src = src.rstrip() + '\n/\n' if not src.rstrip().endswith('/') else src.rstrip() + '\n'
        (OUT / 'TYPE' / tf.name.upper()).write_text(src)
        summary['TYPE'] += 1

    # 4. TABLE (schema)
    for sf in sorted((SRC / 'schema').glob('*.sql')):
        src = sf.read_text()
        src = cross_pkg_rewrite(src)
        src = add_schema_prefix_table(src)
        (OUT / 'TABLE' / sf.name.upper()).write_text(src)
        summary['TABLE'] += 1

    return summary, fmap


# ---- type 方法 formal 改名 ----
METHOD_SIG_RE = re.compile(r'((?:OVERRIDING\s+)?MEMBER\s+(?:FUNCTION|PROCEDURE)\s+\w+\s*\()([^)]*)(\))', re.I)


def rewrite_type_methods(text):
    """type 方法签名里的 formal 改名; 方法体引用一并改。
    简化: 对每个方法签名解析 formals, 在整个文件范围内对私有 p_ 名做整词替换
    (type 方法 formals 互不重名, 且仅 p_on_hand 一个实际存在, 全文件整词替换安全)。"""
    # 收集所有方法 formals 的 old->new
    old_new = {}
    for m in METHOD_SIG_RE.finditer(text):
        params = parse_params(m.group(2))
        for p in params:
            # 同名以首次为准(type 方法间无重名 formal)
            old_new.setdefault(p[0], p[3])
    if not old_new:
        return text
    toks = tokenize(text)
    for i, (kind, txt) in enumerate(toks):
        if kind != 'ident' or txt not in old_new:
            continue
        j = next_non_ws(toks, i + 1)
        if j is not None and toks[j] == ('op', '=>'):
            continue
        toks[i] = ('ident', old_new[txt])
    return detok(toks)


# ---- 校验 ----
def verify(summary, fmap):
    errs = []
    # 1. 计数
    exp = {'PACKAGE': 13, 'PACKAGE_BODY': 12, 'TYPE': 7, 'TABLE': 15}
    for k, v in exp.items():
        if summary.get(k) != v:
            errs.append(f"count {k}={summary.get(k)} expected {v}")

    # 2. 重建新名 formal_map(从生成的 spec)
    new_fmap = {}
    for pf in sorted((OUT / 'PACKAGE').glob('*.sql')):
        spec = pf.read_text()
        pkg_new = pf.stem
        sigs, _ = find_signatures(spec)
        for s in sigs:
            params = parse_params(s['params'])
            new_fmap.setdefault((pkg_new, s['name']), []).append({
                'new_set': set(p[0] for p in params),
                'list': params,
            })

    # 3. 扫所有生成文件里的命名键 => , 校验能被 callee 解析(新名)
    for d in ('PACKAGE_BODY',):
        for bf in sorted((OUT / d).glob('*.sql')):
            pkg_new = bf.stem
            text = bf.read_text()
            toks = tokenize(text)
            stack = []
            i = 0
            n = len(toks)
            while i < n:
                kind, txt = toks[i]
                if kind == 'string':
                    i += 1
                    continue
                if kind == 'punct' and txt == '(':
                    p1 = prev_non_ws(toks, i)
                    callee = None
                    if p1 is not None and toks[p1][0] == 'ident':
                        p0 = prev_non_ws(toks, p1)
                        if p0 is not None and toks[p0] == ('punct', '.'):
                            pm1 = prev_non_ws(toks, p0)
                            if pm1 is not None and toks[pm1][0] == 'ident':
                                callee = (toks[pm1][1], toks[p1][1])
                        else:
                            callee = (pkg_new, toks[p1][1])
                    stack.append(callee)
                    i += 1
                    continue
                if kind == 'punct' and txt == ')':
                    if stack:
                        stack.pop()
                    i += 1
                    continue
                if kind == 'ident':
                    j = next_non_ws(toks, i + 1)
                    if j is not None and toks[j] == ('op', '=>') and stack and stack[-1]:
                        callee = stack[-1]
                        if callee in new_fmap:
                            entries = new_fmap[callee]
                            if not any(txt in e['new_set'] for e in entries):
                                errs.append(f"{bf.name}: 命名键 '{txt} =>' 调用 {callee} 但 callee 无此 formal(新名)")
                    i += 1
                    continue
                i += 1

    # 4. 残留旧包名(除 F_SETTLE 对应的 settle_pkg 已改写)
    for d in ('PACKAGE', 'PACKAGE_BODY', 'TYPE', 'TABLE'):
        for f in (OUT / d).glob('*.sql'):
            text = f.read_text()
            for old in PKG_OLD_FULL:
                if old == 'settle_pkg':
                    continue
                if re.search(r'\b' + re.escape(old) + r'\b', text):
                    errs.append(f"{f.name}: 残留旧包名 {old}")

    return errs


if __name__ == '__main__':
    summary, fmap = transform()
    print('生成完成:', summary)
    errs = verify(summary, fmap)
    if errs:
        print('\n❌ 校验失败:')
        for e in errs:
            print('  -', e)
        sys.exit(1)
    print('\n✅ 校验通过')
