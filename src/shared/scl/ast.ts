// SCL token and AST definitions shared by the lexer, parser, interpreter and listing generator.

export type SclTokenType =
  | 'KEYWORD'
  | 'IDENTIFIER'
  | 'NUMBER'
  | 'REAL'
  | 'STRING'
  | 'TIME'
  | 'OPERATOR'
  | 'PUNCTUATION'
  | 'EOF'

export interface SclToken {
  type: SclTokenType
  value: string
  line: number
  col: number
  quoted?: boolean // Written as "name", which always refers to a global symbol
}

// -----------------------------------------------------------------------------
// AST Node Interfaces
// -----------------------------------------------------------------------------

export type SclStatement =
  | SclAssignStatement
  | SclIfStatement
  | SclCaseStatement
  | SclForStatement
  | SclWhileStatement
  | SclRepeatStatement
  | SclCallStatement
  | SclReturnStatement
  | SclExitStatement
  | SclContinueStatement

export interface SclAssignStatement {
  kind: 'assign'
  line: number
  target: string
  targetQuoted?: boolean
  expression: SclExpression
}

export interface SclIfStatement {
  kind: 'if'
  line: number
  condition: SclExpression
  thenStatements: SclStatement[]
  elsifBranches: Array<{ condition: SclExpression; statements: SclStatement[]; line: number }>
  elseStatements?: SclStatement[]
}

export interface SclCaseStatement {
  kind: 'case'
  line: number
  selector: SclExpression
  cases: Array<{ values: Array<number | { from: number; to: number }>; statements: SclStatement[]; line: number }>
  elseStatements?: SclStatement[]
}

export interface SclForStatement {
  kind: 'for'
  line: number
  iterVar: string
  startExpr: SclExpression
  endExpr: SclExpression
  stepExpr?: SclExpression
  body: SclStatement[]
}

export interface SclWhileStatement {
  kind: 'while'
  line: number
  condition: SclExpression
  body: SclStatement[]
}

export interface SclRepeatStatement {
  kind: 'repeat'
  line: number
  condition: SclExpression
  body: SclStatement[]
}

export interface SclCallStatement {
  kind: 'call'
  line: number
  callee: string
  calleeQuoted?: boolean
  args: Record<string, SclExpression>
  outputArgs?: string[] // Parameter names passed with =>
}

export interface SclContinueStatement {
  kind: 'continue'
  line: number
}

export interface SclReturnStatement {
  kind: 'return'
  line: number
}

export interface SclExitStatement {
  kind: 'exit'
  line: number
}

// Expressions
export type SclExpression =
  | SclLiteralExpr
  | SclVariableExpr
  | SclUnaryExpr
  | SclBinaryExpr
  | SclCallExpr

export interface SclLiteralExpr {
  kind: 'literal'
  value: unknown
  raw: string
  isTime?: boolean
  line: number
}

export interface SclVariableExpr {
  kind: 'variable'
  name: string
  quoted?: boolean
  line: number
}

export interface SclUnaryExpr {
  kind: 'unary'
  op: 'NOT' | '-' | '+'
  expr: SclExpression
  line: number
}

export interface SclBinaryExpr {
  kind: 'binary'
  op: string
  left: SclExpression
  right: SclExpression
  line: number
}

export interface SclCallExpr {
  kind: 'call_expr'
  callee: string
  calleeQuoted?: boolean
  args: Record<string, SclExpression>
  line: number
}
