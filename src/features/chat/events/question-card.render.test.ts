import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { createServer, type ViteDevServer } from "vite";
import { fileURLToPath } from "node:url";

import type { PromptQuestion, Session, SessionEvent } from "../../../types/index.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

let server: ViteDevServer;
let chatHost: typeof import("../host.tsx").ChatHostProvider;

/** 聊天组件从 ChatHost 拿回答提问、Agent 资料和项目目录。测试给一份空的。 */
const testHost = {
  answerPrompt: async () => true,
  profiles: {},
  projectPath: "",
};

function renderInHost(element: ReactElement): string {
  return renderToStaticMarkup(createElement(chatHost, { host: testHost, children: element }));
}
let questionCard: typeof import("./QuestionCard.tsx").QuestionCard;
let elicitationCard: typeof import("./ElicitationCard.tsx").ElicitationCard;
let promptEvent: typeof import("./PromptCard.tsx").PromptEvent;

before(async () => {
  server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  chatHost = (await server.ssrLoadModule("/src/features/chat/host.tsx")).ChatHostProvider;
  questionCard = (await server.ssrLoadModule("/src/features/chat/events/QuestionCard.tsx")).QuestionCard;
  elicitationCard = (await server.ssrLoadModule("/src/features/chat/events/ElicitationCard.tsx")).ElicitationCard;
  promptEvent = (await server.ssrLoadModule("/src/features/chat/events/PromptCard.tsx")).PromptEvent;
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

function question(id: string, text: string): PromptQuestion {
  return { id, question: text, is_secret: false, options: [] };
}

function prompt(
  kind: "questions" | "choice" | "elicitation",
  fields: Partial<Extract<SessionEvent, { kind: "prompt" }>> = {},
): Extract<SessionEvent, { kind: "prompt" }> {
  return {
    id: "e",
    session_id: "s",
    seq: 1,
    ts: 1,
    kind: "prompt",
    prompt_id: "ask",
    prompt_kind: kind,
    question: "",
    options: [],
    questions: [],
    ...fields,
  };
}

const view = {
  time: "10:00",
  thinkingOpen: false,
  onToggleThinking: () => {},
  showAgentLabel: false,
};

test("answered question card hugs the answer and drops trailing blank lines", () => {
  const html = renderInHost(
    createElement(questionCard, {
      event: prompt("questions", {
        question: "贪吃蛇想怎么玩？",
        questions: [question("q1", "贪吃蛇想怎么玩？\n\n")],
      }),
      session,
      resolvedAnswer: "浏览器页面\n\n",
      answerPrompt: () => {},
    }),
  );
  assert.match(html, /px-2\.5 py-1\.5/);
  assert.match(html, /mb-1 /);
  assert.match(html, /leading-5/);
  assert.match(html, /leading-4/);
  assert.equal(html.includes("p-3"), false);
  assert.equal(html.includes("mb-2"), false);
  assert.equal(html.includes("leading-6"), false);
  assert.match(html, />贪吃蛇想怎么玩？<\/p>/);
  assert.match(html, />已回答：浏览器页面<\/p>/);
  assert.equal(html.includes("已回答：\n"), false);
  assert.match(html, /问题/);
  assert.match(html, /border-wb-warn\/25/);
});

test("multiple answers stay stacked without a blank footer", () => {
  const html = renderInHost(
    createElement(questionCard, {
      event: prompt("questions", {
        questions: [question("q1", "第一题"), question("q2", "   ")],
      }),
      session,
      resolvedAnswer: "1. 浏览器页面\r\n2. 键盘\n\n",
      answerPrompt: () => {},
    }),
  );
  assert.match(html, />第一题<\/p>/);
  assert.equal(html.includes(">   <"), false);
  assert.match(html, />已回答：1\. 浏览器页面\n2\. 键盘<\/p>/);
});

test("an open question card stays compact while it waits", () => {
  const html = renderInHost(
    createElement(questionCard, {
      event: prompt("questions", { questions: [question("q1", "贪吃蛇想怎么玩？")] }),
      session: { ...session, status: "needs-input" },
      resolvedAnswer: null,
      answerPrompt: () => {},
    }),
  );
  assert.match(html, /px-2\.5 py-1\.5/);
  assert.match(html, />等待回答…<\/p>/);
  assert.equal(html.includes("p-3"), false);
});

test("settled choice and elicitation cards use the same tight shell", () => {
  const choice = renderInHost(
    createElement(promptEvent, {
      event: prompt("choice", {
        question: "选一个？\n\n",
        options: [{ id: "web", label: "浏览器页面\n" }],
      }),
      session,
      resolvedAnswer: "web",
      ...view,
    }),
  );
  assert.match(choice, /px-2\.5 py-1\.5/);
  assert.match(choice, />选一个？<\/p>/);
  assert.match(choice, />已回答：浏览器页面<\/p>/);
  assert.equal(choice.includes("p-3"), false);
  assert.equal(choice.includes("leading-6"), false);

  const open = renderInHost(
    createElement(promptEvent, {
      event: prompt("choice", {
        question: "选一个？",
        options: [{ id: "web", label: "浏览器页面" }],
      }),
      session: { ...session, status: "needs-input" },
      resolvedAnswer: null,
      ...view,
    }),
  );
  assert.match(open, /p-3/);
  assert.match(open, /leading-6/);
  assert.match(open, /浏览器页面/);

  const elicitation = renderInHost(
    createElement(elicitationCard, {
      event: prompt("elicitation", {
        question: "需要仓库地址\n\n",
        questions: [question("url", "地址")],
      }),
      session,
      resolvedAnswer: "接受\n\n",
      answerPrompt: () => {},
    }),
  );
  assert.match(elicitation, /px-2\.5 py-1\.5/);
  assert.match(elicitation, />需要仓库地址<\/p>/);
  assert.match(elicitation, />已回答：接受<\/p>/);
  assert.equal(elicitation.includes("p-3"), false);
  assert.equal(elicitation.includes('type="button"'), false);
});
