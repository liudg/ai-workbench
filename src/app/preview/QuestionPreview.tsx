import { useState } from "react";

import { EventItem, QuestionPopup } from "@/features/chat";
import type { PromptQuestion, Session, SessionEvent, SessionEventBody } from "@/types";

function session(): Session {
  return {
    id: "question-preview",
    project_id: "preview",
    agent: "codex-cli",
    native_id: "question-preview",
    title: "提问",
    status: "needs-input",
    created_at: 1,
    updated_at: 1,
  };
}

function userEvent(id: string, text: string): SessionEvent {
  return { id, session_id: "question-preview", seq: 1, ts: 1_000, kind: "user-message", text };
}

function display(rows: readonly (readonly [string, string])[]): string {
  return rows.map(([question, answer]) => `> ${question}\n\n${answer}`).join("\n\n");
}

function option(label: string) {
  return { id: label, label, description: "" };
}

function questions(surface: PromptQuestion["surface"]): PromptQuestion[] {
  const asyncReply = surface === "async-reply";
  return [
    {
      id: "q1",
      header: asyncReply ? "" : "框架",
      question: "用哪个框架？",
      description: "",
      is_secret: false,
      is_other: true,
      multi_select: false,
      surface,
      options: [option("Vite"), option("Astro")],
      input_kind: "",
      required: false,
    },
    {
      id: "q2",
      header: asyncReply ? "" : "测试",
      question: "要不要加测试？",
      description: "",
      is_secret: false,
      is_other: true,
      multi_select: false,
      surface,
      options: [option("要"), option("先不要")],
      input_kind: "",
      required: false,
    },
    {
      id: "q3",
      header: asyncReply ? "" : "限制",
      question: "还有别的限制吗？",
      options: [],
      is_secret: false,
      is_other: false,
      multi_select: false,
      surface,
      input_kind: "",
      required: false,
    },
  ];
}

function prompt(surface: PromptQuestion["surface"]): Extract<SessionEventBody, { kind: "prompt" }> {
  const items = questions(surface);
  return {
    kind: "prompt",
    prompt_id: surface ?? "request-input",
    prompt_kind: "questions",
    question: items[0]?.question ?? "",
    options: [],
    questions: items,
  };
}

const answeredTwo = display([
  ["用哪个框架？", "Vite"],
  ["还有限制吗？", "先别加依赖"],
]);

const answeredFive = display([
  ["用哪个框架？", "Vite"],
  ["要不要加测试？", "要"],
  ["包管理用哪个？", "pnpm"],
  ["样式放哪？", "跟组件走"],
  ["还有别的限制吗？", "先别加新依赖"],
]);

export default function QuestionPreview() {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const [surface, setSurface] = useState<PromptQuestion["surface"]>("async-reply");
  const current = session();
  const asking = prompt(surface);
  return (
    <div className="flex h-full min-h-0 flex-col bg-wb-surface text-wb-fg">
      <div className="flex gap-2 px-6 py-3">
        <button
          type="button"
          data-preview-surface="async-reply"
          className="rounded-full border border-wb-border bg-wb-elev px-3 py-1 text-sm text-wb-fg transition-colors hover:bg-wb-hover"
          onClick={() => setSurface("async-reply")}
        >
          异步提问
        </button>
        <button
          type="button"
          data-preview-surface="request-input"
          className="rounded-full border border-wb-border bg-wb-elev px-3 py-1 text-sm text-wb-fg transition-colors hover:bg-wb-hover"
          onClick={() => setSurface("request-input")}
        >
          逐题提问
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto min-h-full w-full max-w-[760px] py-4">
          <EventItem event={userEvent("plain", "帮我看一下这个接口")} session={current} resolvedAnswer={null} />
          <EventItem event={userEvent("two", answeredTwo)} session={current} resolvedAnswer={null} />
          <EventItem event={userEvent("five", answeredFive)} session={current} resolvedAnswer={null} />
        </div>
      </div>
      <div data-chat-column className="mx-auto w-full max-w-[760px] px-4 pb-4">
        <div ref={setAnchor} data-preview-composer className="h-14 rounded-2xl border border-wb-border-strong bg-wb-composer" />
      </div>
      <QuestionPopup key={asking.prompt_id} event={{ ...asking, id: "ask", session_id: current.id, seq: 4, ts: 4 }} sessionId={current.id} anchor={anchor} />
    </div>
  );
}
