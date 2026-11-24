import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createTextSnippet, textSnippetBadge } from "../../../shared/text-snippet.ts";
import {
  formatTerminalSelectionQuote,
  terminalCodeFence,
  terminalSelectionDraft,
  type TerminalSelectionRange,
  type TerminalSelectionSource,
} from "./terminal-selection.ts";

function fakeTerminal(
  selection: string,
  position?: TerminalSelectionRange,
  hasSelection = selection.length > 0,
): TerminalSelectionSource {
  return {
    hasSelection: () => hasSelection,
    getSelection: () => selection,
    getSelectionPosition: () => position,
  };
}

describe("terminal selection to chat snippet", () => {
  test("extracts multi-line selection with 1-based start/end lines and badge 终端:12-25", () => {
    const draft = terminalSelectionDraft(
      fakeTerminal("error[E0308]: mismatched types\r\n  --> src/main.rs:12:5", {
        start: { x: 0, y: 11 },
        end: { x: 22, y: 24 },
      }),
    );
    assert.ok(draft);
    assert.equal(draft.path, "终端");
    assert.equal(draft.start, 12);
    assert.equal(draft.end, 25);
    assert.equal(draft.body, "error[E0308]: mismatched types\n  --> src/main.rs:12:5");
    assert.equal(
      draft.quote,
      "```terminal:12-25\nerror[E0308]: mismatched types\n  --> src/main.rs:12:5\n```",
    );

    const snippet = createTextSnippet(draft, "term-1");
    assert.ok(snippet);
    assert.equal(textSnippetBadge(snippet), "终端:12-25");
  });

  test("formats single-line selection including buffer row 0 as line 1 and custom title", () => {
    const firstRow = terminalSelectionDraft(
      fakeTerminal("$ pnpm test   ", {
        start: { x: 0, y: 0 },
        end: { x: 14, y: 0 },
      }),
      "  构建终端  ",
    );
    assert.ok(firstRow);
    assert.equal(firstRow.path, "构建终端");
    assert.equal(firstRow.start, 1);
    assert.equal(firstRow.end, 1);
    assert.equal(firstRow.body, "$ pnpm test");
    assert.equal(firstRow.quote, "```terminal:1\n$ pnpm test\n```");
    assert.equal(textSnippetBadge(firstRow), "构建终端:1");

    const line12 = terminalSelectionDraft(
      fakeTerminal("PASS all tests\r\n", {
        start: { x: 0, y: 11 },
        end: { x: 0, y: 12 },
      }),
    );
    assert.ok(line12);
    assert.equal(line12.start, 12);
    assert.equal(line12.end, 12);
    assert.equal(textSnippetBadge(line12), "终端:12");
  });

  test("strips trailing blank rows from selectAll and adjusts end line", () => {
    const draft = terminalSelectionDraft(
      fakeTerminal(["line 1", "line 2", "line 3", "   ", "", ""].join("\r\n"), {
        start: { x: 0, y: 0 },
        end: { x: 80, y: 5 },
      }),
    );
    assert.ok(draft);
    assert.equal(draft.start, 1);
    assert.equal(draft.end, 3);
    assert.equal(draft.body, "line 1\nline 2\nline 3");
    assert.equal(textSnippetBadge(draft), "终端:1-3");
  });

  test("expands code fence backticks when selected terminal output contains triple backticks", () => {
    const body = "cat <<EOF\n```ts\nconsole.log(1);\n```\nEOF";
    assert.equal(terminalCodeFence(body), "````");
    const quote = formatTerminalSelectionQuote(body, 4, 8);
    assert.equal(quote, `\`\`\`\`terminal:4-8\n${body}\n\`\`\`\``);
  });

  test("returns null when selection is empty or whitespace-only", () => {
    assert.equal(terminalSelectionDraft(null), null);
    assert.equal(terminalSelectionDraft(fakeTerminal("", undefined, false)), null);
    assert.equal(
      terminalSelectionDraft(
        fakeTerminal("   \r\n  \t \r\n", { start: { x: 0, y: 0 }, end: { x: 5, y: 1 } }),
      ),
      null,
    );
  });
});
