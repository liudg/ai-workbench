import type { DiffFoldRow } from "./fold.ts";

export interface WordPart {
  text: string;
  changed: boolean;
}

export type DiffDisplayRow =
  | { kind: "collapse"; count: number }
  | {
      kind: "line";
      tone: "add" | "del" | "context" | "meta";
      text: string;
      lineNo: number | null;
      oldNo: number | null;
      newNo: number | null;
      parts: WordPart[] | null;
    };

export function applyWordDiff(rows: readonly DiffFoldRow[]): DiffDisplayRow[] {
  const out: DiffDisplayRow[] = rows.map((row) =>
    row.kind === "collapse" ? row : { ...row, parts: null },
  );
  let index = 0;
  while (index < out.length) {
    const start = index;
    while (isTone(out[index], "del")) index += 1;
    const delEnd = index;
    while (isTone(out[index], "add")) index += 1;
    const addEnd = index;
    if (delEnd === start) {
      index = Math.max(index, start + 1);
      continue;
    }
    const pair = Math.min(delEnd - start, addEnd - delEnd);
    for (let cursor = 0; cursor < pair; cursor += 1) {
      const before = out[start + cursor];
      const after = out[delEnd + cursor];
      if (before?.kind !== "line" || after?.kind !== "line") continue;
      const parts = wordDiffParts(before.text, after.text);
      before.parts = parts.before;
      after.parts = parts.after;
    }
  }
  return out;
}

function wordDiffParts(before: string, after: string): { before: WordPart[]; after: WordPart[] } {
  const left = tokenize(before);
  const right = tokenize(after);
  if (left.length * right.length > 4000) {
    const changed = before !== after;
    return {
      before: [{ text: before, changed }],
      after: [{ text: after, changed }],
    };
  }
  const shared = lcsMask(left, right);
  return {
    before: mergeParts(left, shared.left),
    after: mergeParts(right, shared.right),
  };
}

function isTone(row: DiffDisplayRow | undefined, tone: "add" | "del"): boolean {
  return row?.kind === "line" && row.tone === tone;
}

function tokenize(text: string): string[] {
  return text.match(/\s+|[A-Za-z0-9_]+|./g) ?? [];
}

function lcsMask(left: string[], right: string[]): { left: boolean[]; right: boolean[] } {
  const n = left.length;
  const m = right.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const leftChanged = new Array<boolean>(n).fill(true);
  const rightChanged = new Array<boolean>(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      leftChanged[i] = false;
      rightChanged[j] = false;
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1;
    else j += 1;
  }
  return { left: leftChanged, right: rightChanged };
}

function mergeParts(tokens: string[], changed: boolean[]): WordPart[] {
  const parts: WordPart[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const last = parts[parts.length - 1];
    if (last && last.changed === changed[index]) last.text += tokens[index] ?? "";
    else parts.push({ text: tokens[index] ?? "", changed: changed[index] ?? false });
  }
  return parts;
}
