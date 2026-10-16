import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

import type { Session, SessionEvent } from "../../../types/index.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

let server: ViteDevServer;

before(async () => {
  server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
});

after(async () => {
  await server?.close();
});

const session: Session = {
  id: "s",
  project_id: "p",
  agent: "codex-cli",
  native_id: "s",
  title: "t",
  status: "completed",
  created_at: 1,
  updated_at: 1,
};

function userMessage(text: string): SessionEvent {
  return {
    id: "u",
    session_id: "s",
    seq: 1,
    ts: 1,
    kind: "user-message",
    text,
  };
}

function display(rows: readonly (readonly [string, string])[]): string {
  return rows.map(([question, answer]) => `> ${question}\n\n${answer}`).join("\n\n");
}

async function markup(text: string): Promise<string> {
  const mod = await server.ssrLoadModule("/src/features/chat/events/UserBubble.tsx");
  return renderToStaticMarkup(
    createElement(mod.UserBubble, {
      event: userMessage(text),
      session,
      resolvedAnswer: null,
      time: "10:00",
      thinkingOpen: false,
      onToggleThinking: () => {},
      showAgentLabel: false,
    }),
  );
}

test("two answered questions stay expanded and leave the purple bubble", async () => {
  const html = await markup(
    display([
      ["用哪个框架？", "Vite"],
      ["还有限制吗？", "先别加依赖"],
    ]),
  );
  assert.equal(html.includes("data-question-answers"), true);
  assert.equal(html.includes('data-question-count="2"'), true);
  assert.equal(html.includes('data-collapsed="false"'), true);
  assert.equal(html.includes("已回答 2 题"), true);
  assert.equal(html.includes("Vite"), true);
  assert.equal(html.includes("先别加依赖"), true);
  assert.equal(html.includes("6e5bff"), false);
  assert.equal(html.includes("data-user-text"), false);
});

test("five answered questions start collapsed", async () => {
  const rows = [1, 2, 3, 4, 5].map((index) => [`第${index}题`, `答案${index}`] as const);
  const html = await markup(display(rows));
  assert.equal(html.includes('data-question-count="5"'), true);
  assert.equal(html.includes('data-collapsed="true"'), true);
  assert.equal(html.includes("已回答 5 题"), true);
  assert.equal(html.includes("答案1"), false);
  assert.equal(html.includes("答案5"), false);
  assert.equal(html.includes("6e5bff"), false);
});

test("a raw reply envelope renders as the same card", async () => {
  const body = JSON.stringify([
    { answer: "甲", question: "选哪个？", questionItemId: "q1" },
    { answer: "乙", question: "再选一个？", questionItemId: "q2" },
  ]);
  const html = await markup(`<send_user_message_question_reply>\n${body}\n</send_user_message_question_reply>`);
  assert.equal(html.includes("已回答 2 题"), true);
  assert.equal(html.includes("选哪个？"), true);
  assert.equal(html.includes(">甲<") || html.includes("甲"), true);
  assert.equal(html.includes("6e5bff"), false);
});

test("a normal user message stays in the purple bubble", async () => {
  const html = await markup("帮我看一下这个接口");
  assert.equal(html.includes("data-user-text"), true);
  assert.equal(html.includes("6e5bff"), true);
  assert.equal(html.includes("data-question-answers"), false);
  assert.equal(html.includes("帮我看一下这个接口"), true);
});
