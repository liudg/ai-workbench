export type TokenKind = "plain" | "keyword" | "type" | "string" | "comment" | "number";

export interface HighlightToken {
  text: string;
  kind: TokenKind;
}

const KEYWORDS = new Set([
  "using",
  "namespace",
  "class",
  "public",
  "private",
  "protected",
  "internal",
  "static",
  "void",
  "int",
  "bool",
  "string",
  "var",
  "return",
  "if",
  "else",
  "for",
  "foreach",
  "while",
  "new",
  "null",
  "true",
  "false",
  "this",
  "base",
  "function",
  "const",
  "let",
  "export",
  "import",
  "from",
  "type",
  "interface",
  "async",
  "await",
  "fn",
  "pub",
  "mut",
  "impl",
  "struct",
  "enum",
  "match",
  "def",
  "elif",
  "None",
  "True",
  "False",
  "self",
  "in",
  "as",
  "is",
  "override",
  "virtual",
  "abstract",
  "readonly",
]);

/** 一行源码上色。不认某一种语言的完整语法，只标关键字、类型、字符串、注释和数字。 */
export function highlightLine(line: string): HighlightToken[] {
  const tokens: HighlightToken[] = [];
  const push = (text: string, kind: TokenKind) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) last.text += text;
    else tokens.push({ text, kind });
  };

  const trimmed = line.trimStart();
  if (trimmed.startsWith("//") || (trimmed.startsWith("#") && !trimmed.startsWith("#include"))) {
    return [{ text: line, kind: "comment" }];
  }

  let index = 0;
  while (index < line.length) {
    const rest = line.slice(index);
    if (rest.startsWith("//")) {
      push(rest, "comment");
      break;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/", 2);
      const span = end === -1 ? rest.length : end + 2;
      push(rest.slice(0, span), "comment");
      index += span;
      continue;
    }
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      let cursor = 1;
      while (cursor < rest.length) {
        if (rest[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (rest[cursor] === quote) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      push(rest.slice(0, cursor), "string");
      index += cursor;
      continue;
    }
    const number = /^(\d[\d_]*)/.exec(rest);
    const previous = line[index - 1] ?? "";
    if (number && !/[A-Za-z_]/.test(previous)) {
      push(number[1] ?? "", "number");
      index += (number[1] ?? "").length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (word) {
      const text = word[0] ?? "";
      if (KEYWORDS.has(text)) push(text, "keyword");
      else if (/^[A-Z]/.test(text)) push(text, "type");
      else push(text, "plain");
      index += text.length;
      continue;
    }
    push(rest[0] ?? "", "plain");
    index += 1;
  }
  return tokens.length > 0 ? tokens : [{ text: line, kind: "plain" }];
}
