#!/usr/bin/env node
// 从 grammar/ 重新生成 antlr4ts PL/SQL parser 到 .opencode/workflow/plsql-ast/（插件源码一部分）。
//
// 依赖：antlr4ts-cli（仅生成时需 Java 8+，由 npx 按需拉取，不入库）。
// 运行态不重新生成、不依赖 Java，只用入库的生成 TS。
//
// 脚本本身只依赖 node（+ git 定位仓库根 + npx 拉取 cli），不依赖 bash/perl，
// 在 Windows/macOS/Linux 下均可直接：  node .opencode/workflow/plsql-ast/regen.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = ".opencode/workflow/plsql-ast";
const GRAMMARS = ["grammar/PlSqlLexer.g4", "grammar/PlSqlParser.g4"];

// 生成代码引用 superClass 基类但不会自动 import，需注入。
// [文件, 锚点 import 行, 待注入 import 行]
const INJECTIONS = [
  ["PlSqlLexer.ts",
   `import * as Utils from "antlr4ts/misc/Utils";`,
   `import { PlSqlLexerBase } from "./PlSqlLexerBase";`],
  ["PlSqlParser.ts",
   `import { TokenStream } from "antlr4ts/TokenStream";`,
   `import { PlSqlParserBase } from "./PlSqlParserBase";`],
];

// 1. 定位仓库根并切过去（等价 bash: cd "$(git rev-parse --show-toplevel)"）
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
process.chdir(root);

// 2. antlr4ts 生成。用 bunx（环境为 bun，无 npx/npm）。bunx 自动按需拉取 antlr4ts-cli。
// shell:true 让 bunx 在 Windows(cmd)/unix(sh) 下都能被找到。
console.log(`[regen] antlr4ts 生成 → ${OUT}`);
const gen = spawnSync("bunx",
  ["antlr4ts-cli@0.5.0-alpha.4",
   "-o", OUT, "-visitor", "-listener", "-Xexact-output-dir", ...GRAMMARS],
  { stdio: "inherit", shell: true });
if (gen.status !== 0) {
  console.error(`[regen] antlr4ts 生成失败 (exit ${gen.status ?? "null"})`);
  process.exit(gen.status ?? 1);
}

// 3. 注入基类 import（幂等：已注入则跳过）
console.log("[regen] 注入基类 import");
for (const [file, anchor, imp] of INJECTIONS) {
  const p = join(OUT, file);
  const src = readFileSync(p, "utf-8");
  const impLine = imp + "\n";
  if (src.includes(impLine)) continue;                 // 已注入，跳过
  const anchorLine = anchor + "\n";
  if (!src.includes(anchorLine)) {
    console.error(`[regen] 锚点未找到，无法注入: ${file}  (期望: ${anchor})`);
    process.exit(1);
  }
  writeFileSync(p, src.replace(anchorLine, anchorLine + impLine));
}

console.log("[regen] 完成。基类 PlSqlLexerBase.ts / PlSqlParserBase.ts 为手写（antlr4ts 适配版），勿覆盖。");
