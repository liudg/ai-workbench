import { useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

import { pendingPrompt } from "@/lib/utils";
import { useWorkbench } from "@/store";
import type { Session, SessionEvent } from "@/types";

export function Composer({
  session,
  events,
}: {
  session: Session;
  events: SessionEvent[];
}) {
  const sendMessage = useWorkbench((s) => s.sendMessage);
  const answerPrompt = useWorkbench((s) => s.answerPrompt);
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const pendingId = pendingPrompt(events);
  const busy = session.status === "running";
  const dead = session.status === "stopped" || session.status === "failed";

  const placeholder = dead
    ? "会话已停止，请新建会话"
    : busy
      ? "Agent 运行中…"
      : pendingId
        ? "输入回答，或点击上方选项…"
        : "描述你的任务，Enter 发送…";

  const submit = () => {
    const value = text.trim();
    if (!value || busy || dead) return;
    setText("");
    if (pendingId) {
      // 有待回答提问时，输入框内容作为自由文本回答
      answerPrompt(session.id, pendingId, value);
    } else {
      sendMessage(session.id, value);
    }
    textareaRef.current?.focus();
  };

  return (
    <div className="shrink-0 border-t border-zinc-800/80 bg-zinc-900/30 px-6 py-4">
      <div className="mx-auto max-w-3xl">
        <div
          className="flex items-end gap-2 rounded-xl border border-zinc-700/80 bg-zinc-900 px-3 py-2 transition-colors focus-within:border-indigo-500/60"
          onClick={() => textareaRef.current?.focus()}
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={placeholder}
            disabled={busy || dead}
            rows={Math.min(6, Math.max(1, text.split("\n").length))}
            className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-sm leading-6 text-zinc-200 placeholder:text-zinc-600 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          />
          <button
            onClick={submit}
            disabled={!text.trim() || busy || dead}
            className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-500"
            title="发送 (Enter)"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
          </button>
        </div>
        <p className="mt-1.5 text-center text-[11px] text-zinc-600">
          Enter 发送 · Shift+Enter 换行 · 关闭窗口不会中断会话（驻留系统托盘）
        </p>
      </div>
    </div>
  );
}
