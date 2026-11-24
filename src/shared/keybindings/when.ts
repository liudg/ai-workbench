// `when` 条件表达式：词法分析、递归下降 AST 解析、序列化、未知变量检查与求值。

import { WHEN_CONTEXT_VARIABLES, type WhenContext } from "./types.ts";

export const MAX_WHEN_DEPTH = 24;

const KNOWN_VARIABLES: ReadonlySet<string> = new Set<string>(WHEN_CONTEXT_VARIABLES);

export type WhenNode =
  | { type: "literal"; value: boolean }
  | { type: "identifier"; name: string }
  | { type: "not"; operand: WhenNode }
  | { type: "and"; left: WhenNode; right: WhenNode }
  | { type: "or"; left: WhenNode; right: WhenNode };

type ParseWhenResult =
  | { ok: true; ast: WhenNode | null }
  | { ok: false; error: string; position: number };

type TokenKind = "ident" | "not" | "and" | "or" | "lparen" | "rparen" | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

function isIdentStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= "0" && ch <= "9") || ch === ".";
}

function tokenizeWhen(source: string): { ok: true; tokens: Token[] } | { ok: false; error: string; position: number } {
  const tokens: Token[] = [];
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "!") {
      tokens.push({ kind: "not", value: "!", pos: i });
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen", value: "(", pos: i });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen", value: ")", pos: i });
      i += 1;
      continue;
    }
    if (ch === "&" && source[i + 1] === "&") {
      tokens.push({ kind: "and", value: "&&", pos: i });
      i += 2;
      continue;
    }
    if (ch === "|" && source[i + 1] === "|") {
      tokens.push({ kind: "or", value: "||", pos: i });
      i += 2;
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      i += 1;
      while (i < len && isIdentPart(source[i])) i += 1;
      tokens.push({ kind: "ident", value: source.slice(start, i), pos: start });
      continue;
    }
    return { ok: false, error: `无法识别的符号 "${source.slice(i, i + 2)}"`, position: i };
  }
  tokens.push({ kind: "eof", value: "", pos: len });
  return { ok: true, tokens };
}

class WhenParser {
  private readonly tokens: readonly Token[];
  private cursor = 0;

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.cursor] ?? this.tokens[this.tokens.length - 1];
  }

  private consume(): Token {
    const current = this.peek();
    if (current.kind !== "eof") this.cursor += 1;
    return current;
  }

  parseRoot(): ParseWhenResult {
    if (this.peek().kind === "eof") return { ok: true, ast: null };
    const result = this.parseOr(0);
    if (!result.ok) return result;
    const trailing = this.peek();
    if (trailing.kind !== "eof") {
      return { ok: false, error: `意外的符号 "${trailing.value}"`, position: trailing.pos };
    }
    return result;
  }

  private parseOr(depth: number): ParseWhenResult {
    if (depth > MAX_WHEN_DEPTH) {
      return { ok: false, error: `表达式嵌套超过上限（最多 ${MAX_WHEN_DEPTH} 层）`, position: this.peek().pos };
    }
    let leftResult = this.parseAnd(depth);
    if (!leftResult.ok || !leftResult.ast) return leftResult;
    let left = leftResult.ast;
    while (this.peek().kind === "or") {
      this.consume();
      const rightResult = this.parseAnd(depth);
      if (!rightResult.ok || !rightResult.ast) return rightResult;
      left = { type: "or", left, right: rightResult.ast };
    }
    return { ok: true, ast: left };
  }

  private parseAnd(depth: number): ParseWhenResult {
    let leftResult = this.parseUnary(depth);
    if (!leftResult.ok || !leftResult.ast) return leftResult;
    let left = leftResult.ast;
    while (this.peek().kind === "and") {
      this.consume();
      const rightResult = this.parseUnary(depth);
      if (!rightResult.ok || !rightResult.ast) return rightResult;
      left = { type: "and", left, right: rightResult.ast };
    }
    return { ok: true, ast: left };
  }

  private parseUnary(depth: number): ParseWhenResult {
    if (depth > MAX_WHEN_DEPTH) {
      return { ok: false, error: `表达式嵌套超过上限（最多 ${MAX_WHEN_DEPTH} 层）`, position: this.peek().pos };
    }
    if (this.peek().kind === "not") {
      this.consume();
      const inner = this.parseUnary(depth + 1);
      if (!inner.ok || !inner.ast) return inner;
      return { ok: true, ast: { type: "not", operand: inner.ast } };
    }
    return this.parsePrimary(depth);
  }

  private parsePrimary(depth: number): ParseWhenResult {
    const token = this.peek();
    if (token.kind === "lparen") {
      this.consume();
      if (this.peek().kind === "rparen") {
        return { ok: false, error: "括号内不能为空", position: token.pos };
      }
      const inner = this.parseOr(depth + 1);
      if (!inner.ok) return inner;
      if (this.peek().kind !== "rparen") {
        return { ok: false, error: "缺少右括号 \")\"", position: this.peek().pos };
      }
      this.consume();
      return inner;
    }
    if (token.kind === "ident") {
      this.consume();
      if (token.value === "true") return { ok: true, ast: { type: "literal", value: true } };
      if (token.value === "false") return { ok: true, ast: { type: "literal", value: false } };
      return { ok: true, ast: { type: "identifier", name: token.value } };
    }
    if (token.kind === "eof") {
      return { ok: false, error: "表达式不完整", position: token.pos };
    }
    return { ok: false, error: `意外的符号 "${token.value}"`, position: token.pos };
  }
}

export function parseWhen(when: string | undefined): ParseWhenResult {
  if (!when || !when.trim()) return { ok: true, ast: null };
  const lexed = tokenizeWhen(when);
  if (!lexed.ok) return lexed;
  return new WhenParser(lexed.tokens).parseRoot();
}

function precedence(node: WhenNode): number {
  switch (node.type) {
    case "or":
      return 1;
    case "and":
      return 2;
    case "not":
      return 3;
    case "identifier":
    case "literal":
      return 4;
  }
}

/** 将 AST 序列化为规范字符串（按运算符优先级自动加最简括号）。 */
export function serializeWhen(ast: WhenNode | null): string {
  if (!ast) return "";
  switch (ast.type) {
    case "literal":
      return ast.value ? "true" : "false";
    case "identifier":
      return ast.name;
    case "not": {
      const inner = serializeWhen(ast.operand);
      return precedence(ast.operand) < precedence(ast) ? `!(${inner})` : `!${inner}`;
    }
    case "and": {
      const left = precedence(ast.left) < precedence(ast) ? `(${serializeWhen(ast.left)})` : serializeWhen(ast.left);
      const right = precedence(ast.right) < precedence(ast) ? `(${serializeWhen(ast.right)})` : serializeWhen(ast.right);
      return `${left} && ${right}`;
    }
    case "or":
      return `${serializeWhen(ast.left)} || ${serializeWhen(ast.right)}`;
  }
}

/** 收集 AST 中引用的所有变量名（去重，保留首次出现顺序）。 */
export function collectWhenVariables(ast: WhenNode | null): string[] {
  if (!ast) return [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  const walk = (node: WhenNode) => {
    switch (node.type) {
      case "literal":
        return;
      case "identifier":
        if (!seen.has(node.name)) {
          seen.add(node.name);
          ordered.push(node.name);
        }
        return;
      case "not":
        walk(node.operand);
        return;
      case "and":
      case "or":
        walk(node.left);
        walk(node.right);
    }
  };
  walk(ast);
  return ordered;
}

/** 检测表达式或 AST 中未在 `WhenContext` 声明的变量。 */
export function findUnknownWhenVariables(input: string | WhenNode | null | undefined): string[] {
  if (!input) return [];
  if (typeof input === "string") {
    const parsed = parseWhen(input);
    if (!parsed.ok) return [];
    return collectWhenVariables(parsed.ast).filter((name) => !KNOWN_VARIABLES.has(name));
  }
  return collectWhenVariables(input).filter((name) => !KNOWN_VARIABLES.has(name));
}

export interface WhenValidation {
  valid: boolean;
  normalized: string;
  error?: string;
  unknownVariables: string[];
}

export function validateWhenExpression(when: string | undefined): WhenValidation {
  const parsed = parseWhen(when);
  if (!parsed.ok) {
    return {
      valid: false,
      normalized: when?.trim() ?? "",
      error: parsed.error,
      unknownVariables: [],
    };
  }
  const normalized = serializeWhen(parsed.ast);
  if (parsed.ast?.type === "literal" && parsed.ast.value === false) {
    return {
      valid: false,
      normalized,
      error: "要停用快捷键请点击清除按钮，不要将 when 设为 false",
      unknownVariables: [],
    };
  }
  const unknownVariables = findUnknownWhenVariables(parsed.ast);
  return {
    valid: unknownVariables.length === 0,
    normalized,
    error: unknownVariables.length > 0 ? `未知上下文变量：${unknownVariables.join(", ")}` : undefined,
    unknownVariables,
  };
}

export function evaluateWhenAst(ast: WhenNode | null, context: Partial<Record<string, boolean>>): boolean {
  if (!ast) return true;
  switch (ast.type) {
    case "literal":
      return ast.value;
    case "identifier":
      return Boolean(context[ast.name]);
    case "not":
      return !evaluateWhenAst(ast.operand, context);
    case "and":
      return evaluateWhenAst(ast.left, context) && evaluateWhenAst(ast.right, context);
    case "or":
      return evaluateWhenAst(ast.left, context) || evaluateWhenAst(ast.right, context);
  }
}

export function evaluateWhen(when: string | undefined, context: Partial<WhenContext>): boolean {
  if (!when || !when.trim()) return true;
  const parsed = parseWhen(when);
  if (!parsed.ok) return false;
  return evaluateWhenAst(parsed.ast, context);
}
