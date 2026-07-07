// antlr4ts 版 PlSqlLexer 基类（从 grammars-v4 sql/plsql/TypeScript/PlSqlLexerBase.ts 适配）
// 原 grammar 用 superClass = PlSqlLexerBase；antlr4ts 4.7.2 生成代码继承本类。
import { Lexer } from "antlr4ts/Lexer"

export abstract class PlSqlLexerBase extends Lexer {
  IsNewlineAtPos(pos: number): boolean {
    const la = this._input.LA(pos)
    return la === -1 || String.fromCharCode(la) === "\n"
  }
}
