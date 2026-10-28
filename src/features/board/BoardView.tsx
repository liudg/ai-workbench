import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { AttentionPill, type BoardColumn } from "@/shared/attention";
import { relativeSessionTime } from "@/shared/format/relative-time";
import type { BoardLane } from "./board-model";
import { useBoard, type BoardCard } from "./use-board";

const COLUMN_TITLE: Record<BoardColumn, string> = {
  "needs-you": "要你处理",
  working: "运行中",
  done: "已完成",
  idle: "空闲",
};

/** 看板：所有会话按「要你处理 / 运行中 / 已完成 / 空闲」分四列。照 orca `dashboard-popout/AgentKanbanBoard.tsx`。 */
export function BoardView() {
  const { lanes, loading, now, open, close } = useBoard();
  const total = lanes.reduce((sum, lane) => sum + lane.cards.length + lane.hidden, 0);

  return (
    <div data-board="" className="flex min-h-0 flex-1 flex-col bg-[#0f0f0f]">
      <header className="flex shrink-0 items-center gap-2 border-b border-[#222] px-4 py-2.5">
        <h1 className="text-[13px] font-semibold text-[#e8e8e8]">看板</h1>
        {!loading && <span className="text-[11px] text-[#777]">共 {total} 个会话</span>}
        <button
          type="button"
          aria-label="关闭看板"
          className="ml-auto rounded p-1 text-[#8a8a8a] hover:bg-white/[0.06] hover:text-[#e8e8e8]"
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
      className="flex min-w-[200px] flex-1 flex-col rounded-xl border border-[#222] bg-[#141414]"
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <span className="text-[11px] font-semibold text-[#9a9a9a]">{COLUMN_TITLE[lane.column]}</span>
        <span className="ml-auto rounded-full bg-[#0f0f0f] px-1.5 text-[11px] tabular-nums text-[#8a8a8a]">{count}</span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {lane.cards.length === 0 && <p className="px-1 py-2 text-[11px] text-[#666]">没有</p>}
        {lane.cards.map((card) => (
          <Card key={card.id} card={card} column={lane.column} now={now} onOpen={onOpen} />
        ))}
        {lane.hidden > 0 && <p className="px-1 py-1 text-[11px] text-[#666]">还有 {lane.hidden} 个，在侧栏里</p>}
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
        "flex w-full flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors",
        column === "needs-you"
          ? "border-[#f0a04a]/30 bg-[#f0a04a]/[0.05] hover:border-[#f0a04a]/50"
          : column === "done"
            ? "border-emerald-500/30 bg-emerald-500/[0.05] hover:border-emerald-500/50"
            : "border-[#262626] bg-[#1a1a1a] hover:border-[#333]",
      )}
      onClick={() => onOpen(card)}
    >
      <span className="flex w-full items-center gap-1.5">
        <SessionAgentIcon identity={card.identity} className="h-3.5 w-3.5" />
        <span className={cn("min-w-0 flex-1 truncate text-[12.5px]", unread ? "font-semibold text-[#f3f3f3]" : "text-[#bdbdbd]")}>
          {card.title}
        </span>
        <AttentionPill pill={card.pill} />
      </span>
      {card.attention.preview && (
        <span className="line-clamp-2 text-[11.5px] leading-snug text-[#a8a8a8]">{card.attention.preview}</span>
      )}
      <span className="flex w-full items-center gap-1.5 text-[10.5px] text-[#777]">
        <span className="min-w-0 truncate">{card.place ?? "独立聊天"}</span>
        {card.branch && <span className="min-w-0 truncate rounded bg-[#242424] px-1 text-[#8a8a8a]">{card.branch}</span>}
        <span className="ml-auto shrink-0 tabular-nums">{relativeSessionTime(card.attention.updatedAt, now)}</span>
      </span>
    </button>
  );
}
