import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { AttentionPill, type BoardColumn } from "@/shared/attention";
import { relativeSessionTime } from "@/shared/format/relative-time";
import type { BoardLane } from "./board-model";
import { useBoard, type BoardCard } from "./use-board";

const COLUMN_TITLE: Record<BoardColumn, string> = {
  "needs-you": "待处理",
  working: "运行中",
  done: "已完成",
  idle: "空闲",
};

/** 看板：所有会话按「待处理 / 运行中 / 已完成 / 空闲」分四列。照 orca `dashboard-popout/AgentKanbanBoard.tsx`。 */
export function BoardView() {
  const { lanes, loading, now, open, close } = useBoard();
  const total = lanes.reduce((sum, lane) => sum + lane.cards.length + lane.hidden, 0);

  return (
    <div data-board="" className="flex min-h-0 flex-1 flex-col bg-wb-surface">
      <header className="flex h-11 shrink-0 items-center gap-2.5 border-b border-wb-border px-4">
        <h1 className="text-[13px] font-semibold tracking-tight text-wb-fg">全局看板</h1>
        {!loading && <span className="text-xs text-wb-fg-3">{total} 个会话</span>}
        <button
          type="button"
          aria-label="关闭看板"
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-fg"
          onClick={close}
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 overflow-x-auto p-3">
        <div className="mx-auto flex w-full max-w-[1280px] gap-3">
          {lanes.map((lane) => (
            <Lane key={lane.column} lane={lane} now={now} onOpen={open} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Lane({ lane, now, onOpen }: { lane: BoardLane<BoardCard>; now: number; onOpen: (card: BoardCard) => void }) {
  const count = lane.cards.length + lane.hidden;
  return (
    <section
      data-board-column={lane.column}
      className="flex min-w-[220px] flex-1 flex-col rounded-xl border border-wb-border bg-wb-panel"
    >
      <header className="flex items-center gap-2 border-b border-wb-border px-3 py-2.5">
        <span className="text-xs font-medium text-wb-fg-2">{COLUMN_TITLE[lane.column]}</span>
        <span className="ml-auto rounded-full bg-wb-elev px-2 py-0.5 text-[11px] font-medium tabular-nums text-wb-fg-2">
          {count}
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {lane.cards.length === 0 && <p className="px-2 py-4 text-center text-xs text-wb-fg-3">暂无会话</p>}
        {lane.cards.map((card) => (
          <Card key={card.id} card={card} column={lane.column} now={now} onOpen={onOpen} />
        ))}
        {lane.hidden > 0 && <p className="px-2 py-1 text-[11px] text-wb-fg-3">其余 {lane.hidden} 个见侧边栏</p>}
      </div>
    </section>
  );
}

function Card({
  card,
  column,
  now,
  onOpen,
}: {
  card: BoardCard;
  column: BoardColumn;
  now: number;
  onOpen: (card: BoardCard) => void;
}) {
  const unread = card.attention.unread;
  return (
    <button
      type="button"
      data-board-card={card.id}
      className={cn(
        "flex w-full flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors",
        column === "needs-you"
          ? "border-wb-warn/35 bg-wb-warn-soft hover:border-wb-warn/60"
          : column === "done"
            ? "border-wb-ok/30 bg-wb-ok-soft hover:border-wb-ok/55"
            : "border-wb-border bg-wb-surface hover:border-wb-border-strong hover:bg-wb-elev/70",
      )}
      onClick={() => onOpen(card)}
    >
      <span className="flex w-full items-center gap-1.5">
        <SessionAgentIcon identity={card.identity} className="h-3.5 w-3.5" />
        <span className={cn("min-w-0 flex-1 truncate text-[13px]", unread ? "font-semibold text-wb-fg" : "text-wb-fg-2")}>
          {card.title}
        </span>
        <AttentionPill pill={card.pill} />
      </span>
      {card.attention.preview && (
        <span className="line-clamp-2 text-xs leading-snug text-wb-fg-2">{card.attention.preview}</span>
      )}
      <span className="flex w-full items-center gap-1.5 pt-0.5 text-[11px] text-wb-fg-3">
        <span className="min-w-0 truncate">{card.place ?? "独立对话"}</span>
        {card.branch && (
          <span className="min-w-0 truncate rounded border border-wb-border bg-wb-elev px-1.5 text-[10px] text-wb-fg-2">
            {card.branch}
          </span>
        )}
        <span className="ml-auto shrink-0 tabular-nums">{relativeSessionTime(card.attention.updatedAt, now)}</span>
      </span>
    </button>
  );
}
