// antlr4ts 版 PlSqlParser 基类（从 grammars-v4 sql/plsql/TypeScript/PlSqlParserBase.ts 适配）
// 提供 grammar 语义谓词所需方法：isVersion10/11/12、IsNotNumericFunction、isNotStartOfJoin。
import { Parser } from "antlr4ts/Parser"
import { TokenStream } from "antlr4ts/TokenStream"
import { PlSqlLexer } from "./PlSqlLexer"

export abstract class PlSqlParserBase extends Parser {
  _isVersion10 = false
  _isVersion11 = true
  _isVersion12 = true

  constructor(input: TokenStream) {
    super(input)
  }

  isVersion10(): boolean { return this._isVersion10 }
  isVersion11(): boolean { return this._isVersion11 }
  isVersion12(): boolean { return this._isVersion12 }
  setVersion10(v: boolean): void { this._isVersion10 = v }
  setVersion11(v: boolean): void { this._isVersion11 = v }
  setVersion12(v: boolean): void { this._isVersion12 = v }

  IsNotNumericFunction(): boolean {
    const ts = this.inputStream
    const lt1 = ts.tryLT(1)
    const lt2 = ts.tryLT(2)
    if (lt1 && lt2 &&
      (lt1.type === PlSqlLexer.SUM || lt1.type === PlSqlLexer.COUNT || lt1.type === PlSqlLexer.AVG ||
        lt1.type === PlSqlLexer.MIN || lt1.type === PlSqlLexer.MAX || lt1.type === PlSqlLexer.ROUND ||
        lt1.type === PlSqlLexer.LEAST || lt1.type === PlSqlLexer.GREATEST) &&
      lt2.type === PlSqlLexer.LEFT_PAREN) {
      return false
    }
    return true
  }

  isNotStartOfJoin(): boolean {
    const lt1 = this.inputStream.tryLT(1)
    if (lt1 &&
      (lt1.type === PlSqlLexer.INNER || lt1.type === PlSqlLexer.CROSS || lt1.type === PlSqlLexer.NATURAL ||
        lt1.type === PlSqlLexer.PARTITION || lt1.type === PlSqlLexer.FULL || lt1.type === PlSqlLexer.LEFT ||
        lt1.type === PlSqlLexer.RIGHT || lt1.type === PlSqlLexer.OUTER)) {
      return false
    }
    return true
  }
}
