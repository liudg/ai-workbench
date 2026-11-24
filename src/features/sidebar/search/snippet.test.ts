import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseSnippetSegments,
  resolveSearchProjectName,
  searchHitRoleLabel,
} from "../../../shared/search/snippet.ts";

test("parseSnippetSegments highlights multiple terms case-insensitively while preserving original casing", () => {
  const segments = parseSnippetSegments(
    "…在 Auth 模块修复了登录 OAuth2 Token 过期报错…",
    "oauth2   登录",
  );
  assert.deepEqual(segments, [
    { text: "…在 Auth 模块修复了", highlight: false },
    { text: "登录", highlight: true },
    { text: " ", highlight: false },
    { text: "OAuth2", highlight: true },
    { text: " Token 过期报错…", highlight: false },
  ]);
});

test("parseSnippetSegments prefers longer overlapping query terms over shorter prefixes", () => {
  const segments = parseSnippetSegments("check auth_token refresh", "auth auth_token");
  assert.deepEqual(segments, [
    { text: "check ", highlight: false },
    { text: "auth_token", highlight: true },
    { text: " refresh", highlight: false },
  ]);
});

test("parseSnippetSegments preserves literal [[ and ]] brackets and regex metacharacters safely", () => {
  assert.deepEqual(
    parseSnippetSegments("参见 [[登录架构]] 与 [[未闭合 c++ (v1.2)", "登录 c++ (v1.2)"),
    [
      { text: "参见 [[", highlight: false },
      { text: "登录", highlight: true },
      { text: "架构]] 与 [[未闭合 ", highlight: false },
      { text: "c++", highlight: true },
      { text: " ", highlight: false },
      { text: "(v1.2)", highlight: true },
    ],
  );

  assert.deepEqual(
    parseSnippetSegments("matrix[[idx]] = 42", "[[idx]]"),
    [
      { text: "matrix", highlight: false },
      { text: "[[idx]]", highlight: true },
      { text: " = 42", highlight: false },
    ],
  );
});

test("parseSnippetSegments keeps raw HTML payloads as plain text segments with zero XSS interpretation", () => {
  const payload = "<script>alert('xss')</script><img src=x onerror=alert(1)> token";
  const segments = parseSnippetSegments(payload, "token");
  assert.deepEqual(segments, [
    { text: "<script>alert('xss')</script><img src=x onerror=alert(1)> ", highlight: false },
    { text: "token", highlight: true },
  ]);
});

test("parseSnippetSegments handles empty snippet or empty query cleanly", () => {
  assert.deepEqual(parseSnippetSegments("", "query"), []);
  assert.deepEqual(parseSnippetSegments("plain text", "   "), [
    { text: "plain text", highlight: false },
  ]);
  assert.deepEqual(parseSnippetSegments("plain text", "`**` ``"), [
    { text: "plain text", highlight: false },
  ]);
});

test("parseSnippetSegments strips inline Markdown backticks and ** so wrapped queries highlight cleanly", () => {
  assert.deepEqual(
    parseSnippetSegments("调用 fetch_user_token 时抛出 AuthError 异常", "`fetch_user_token` **AuthError**"),
    [
      { text: "调用 ", highlight: false },
      { text: "fetch_user_token", highlight: true },
      { text: " 时抛出 ", highlight: false },
      { text: "AuthError", highlight: true },
      { text: " 异常", highlight: false },
    ],
  );
});

test("searchHitRoleLabel and resolveSearchProjectName format badges consistently", () => {
  assert.equal(searchHitRoleLabel("title"), "标题");
  assert.equal(searchHitRoleLabel("user"), "用户");
  assert.equal(searchHitRoleLabel("assistant"), "助手");
  assert.equal(searchHitRoleLabel("other"), "消息");

  const projects = [{ id: "p1", name: "AI Workbench" }];
  assert.equal(resolveSearchProjectName("p1", projects), "AI Workbench");
  assert.equal(resolveSearchProjectName(null, projects), "聊天");
  assert.equal(resolveSearchProjectName(undefined, projects), "聊天");
  assert.equal(resolveSearchProjectName("missing", projects), "项目");
});
