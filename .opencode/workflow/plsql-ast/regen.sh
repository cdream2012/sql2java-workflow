#!/usr/bin/env bash
# 从 grammar/ 重新生成 antlr4ts PL/SQL parser 到 .opencode/workflow/plsql-ast/（插件源码一部分）。
# 依赖：antlr4ts-cli（仅生成时需 Java 8+）。运行态不重新生成、不依赖 Java，只用入库的生成 TS。
#
# 用法：从仓库根目录执行  bash .opencode/workflow/plsql-ast/regen.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

OUT=.opencode/workflow/plsql-ast
echo "[regen] antlr4ts 生成 → $OUT"
# antlr4ts-cli 仅生成时需要（依赖 Java 8+），按需 npx 拉取，不入库。
npx -y -p antlr4ts-cli@0.5.0-alpha.4 antlr4ts \
  -o "$OUT" -visitor -listener -Xexact-output-dir \
  grammar/PlSqlLexer.g4 grammar/PlSqlParser.g4

# 生成代码引用 superClass 基类但不会自动 import，需注入。
echo "[regen] 注入基类 import"
perl -0pi -e 's/(import \* as Utils from "antlr4ts\/misc\/Utils";\n)/$1import { PlSqlLexerBase } from ".\/PlSqlLexerBase";\n/' "$OUT/PlSqlLexer.ts"
perl -0pi -e 's/(import \{ TokenStream \} from "antlr4ts\/TokenStream";\n)/$1import { PlSqlParserBase } from ".\/PlSqlParserBase";\n/' "$OUT/PlSqlParser.ts"

echo "[regen] 完成。基类 PlSqlLexerBase.ts / PlSqlParserBase.ts 为手写（antlr4ts 适配版），勿覆盖。"
