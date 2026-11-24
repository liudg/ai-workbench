import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_PROMPT_LINK_LENGTH,
  formatHiddenCharactersWarning,
  sanitizePromptLink,
  shouldConfirmDraftOverwrite,
} from "./prompt-link.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("tauri.conf.json configures the aiwb deep-link scheme", () => {
  const conf = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  assert.deepEqual(conf.plugins?.["deep-link"]?.desktop?.schemes, ["aiwb"]);
});

test("preserves normal multiline text, tabs, CJK, and valid emoji ZWJ sequences", () => {
  const input = "请检查这段代码 👨‍💻 并修复 👩‍❤️‍👨 / 🏳️‍🌈 / 👩🏽‍🚀 / 🏃‍♀️ 的渲染\r\n\t第二行";
  const result = sanitizePromptLink(input);
  assert.deepEqual(result, {
    ok: true,
    prompt: "请检查这段代码 👨‍💻 并修复 👩‍❤️‍👨 / 🏳️‍🌈 / 👩🏽‍🚀 / 🏃‍♀️ 的渲染\n\t第二行",
    hiddenCharactersRemoved: 0,
    truncated: false,
  });
});

test("strips zero-width, C0/C1 control, BiDi override/isolate, BOM, and Plane 14 tag characters", () => {
  const smuggledTags = String.fromCodePoint(0xe0001, 0xe0069, 0xe0067, 0xe0105);
  const input =
    "\uFEFF检\u200B查\u200C日\u200E志\u200F " +
    "\u202Eevil\u202C " +
    "\u2066isolated\u2069 " +
    "\u0000\u0007\u000B\u001B\u007F\u009F" +
    smuggledTags;

  const result = sanitizePromptLink(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.prompt, "检查日志 evil isolated ");
  // 1(BOM) + 4(ZWSP/ZWNJ/LRM/RLM) + 2(RLO/PDF) + 2(LRI/PDI) + 6(C0/DEL/C1) + 4(Plane 14) = 19
  assert.equal(result.hiddenCharactersRemoved, 19);
  assert.equal(result.truncated, false);
  assert.equal(
    formatHiddenCharactersWarning(result.hiddenCharactersRemoved),
    "检测到并移除了 19 个隐藏字符，发送前请仔细核对内容",
  );
});

test("strips standalone or non-emoji ZWJ while keeping valid emoji ZWJ in the same prompt", () => {
  const input = "rm\u200D -rf 👨‍💻\u200D \u200Da\u200Db";
  const result = sanitizePromptLink(input);
  assert.deepEqual(result, {
    ok: true,
    prompt: "rm -rf 👨‍💻 ab",
    hiddenCharactersRemoved: 4,
    truncated: false,
  });
});

test("strips hidden character injected inside a broken emoji ZWJ sequence", () => {
  const input = "👨\u200B\u200D💻";
  const result = sanitizePromptLink(input);
  assert.deepEqual(result, {
    ok: true,
    prompt: "👨💻",
    hiddenCharactersRemoved: 2,
    truncated: false,
  });
});

test("rejects prompts that consist only of hidden characters or whitespace + hidden characters", () => {
  const onlyHidden = sanitizePromptLink("\u200B\u202E\uFEFF\u{E0041}\u0000");
  assert.deepEqual(onlyHidden, {
    ok: false,
    reason: "only-hidden",
    hiddenCharactersRemoved: 5,
  });

  const whitespaceAndHidden = sanitizePromptLink("  \n\t\u2066\u2069\uFE00  ");
  assert.deepEqual(whitespaceAndHidden, {
    ok: false,
    reason: "only-hidden",
    hiddenCharactersRemoved: 3,
  });

  const plainEmpty = sanitizePromptLink("   \n\t  ");
  assert.deepEqual(plainEmpty, {
    ok: false,
    reason: "empty",
    hiddenCharactersRemoved: 0,
  });
});

test("enforces 8,000 character max length without splitting emoji ZWJ sequences", () => {
  const longAscii = "a".repeat(MAX_PROMPT_LINK_LENGTH + 250);
  const resAscii = sanitizePromptLink(longAscii);
  assert.equal(resAscii.ok, true);
  if (resAscii.ok) {
    assert.equal(resAscii.prompt.length, MAX_PROMPT_LINK_LENGTH);
    assert.equal(resAscii.truncated, true);
    assert.equal(resAscii.hiddenCharactersRemoved, 0);
  }

  // 在 8,000 边界处放置 5 个 UTF-16 码元长的 `👨‍💻`（`\u{1F468}\u200D\u{1F4BB}`），确保不会切出一半代理对或悬挂 ZWJ。
  const prefix = "x".repeat(MAX_PROMPT_LINK_LENGTH - 3);
  const boundaryEmoji = `${prefix}👨‍💻尾部`;
  const resEmoji = sanitizePromptLink(boundaryEmoji);
  assert.equal(resEmoji.ok, true);
  if (resEmoji.ok) {
    assert.ok(resEmoji.prompt.length <= MAX_PROMPT_LINK_LENGTH);
    assert.equal(resEmoji.prompt, prefix);
    assert.equal(resEmoji.truncated, true);
    assert.equal(resEmoji.prompt.endsWith("\u200D"), false);
  }
});

test("shouldConfirmDraftOverwrite requires confirmation only when existing draft is non-empty and different", () => {
  assert.equal(shouldConfirmDraftOverwrite("", "新提示词"), false);
  assert.equal(shouldConfirmDraftOverwrite("   \n  ", "新提示词"), false);
  assert.equal(shouldConfirmDraftOverwrite("相同内容", "相同内容"), false);
  assert.equal(shouldConfirmDraftOverwrite("写了一半的草稿", "外部传入的新提示词"), true);
});
