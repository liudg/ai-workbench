import { File, Folder, Lightbulb, Target } from "lucide-react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import {
  highlightParts,
  MENTION_ADD_ORDER,
  type MentionAddId,
  type MentionFile,
  type MentionSupport,
} from "./mentions";

export type { MentionAddId };

const ADD_ITEMS: { id: MentionAddId; label: string; hint: string }[] = [
  { id: "files", label: DESKTOP_ZH.addFiles, hint: "" },
  { id: "goal", label: DESKTOP_ZH.goalLabel, hint: DESKTOP_ZH.goalHint },
  { id: "plan", label: DESKTOP_ZH.planTitle, hint: DESKTOP_ZH.planOn },
];

function supportHint(support: MentionSupport, hint: string): string {
  if (support === "loading") return DESKTOP_ZH.mentionLoadingCaps;
  if (support === "unsupported") {
    return hint === DESKTOP_ZH.goalHint ? DESKTOP_ZH.mentionNoGoal : DESKTOP_ZH.mentionNoPlan;
  }
  return hint;
}

export function MentionMenu({
  mode,
  active,
  goalSupport,
  planSupport,
  goalNotice,
  files,
  pending,
  error,
  query,
  onPick,
}: {
  mode: "add" | "files";
  active: number;
  goalSupport: MentionSupport;
  planSupport: MentionSupport;
  goalNotice?: string | null;
  files: MentionFile[];
  pending: boolean;
  error: string | null;
  query: string;
  onPick: (id: MentionAddId | MentionFile) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label={mode === "add" ? DESKTOP_ZH.addSection : "文件"}
      data-mention-menu={mode}
      className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-72 min-w-0 overflow-x-hidden overflow-y-auto rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] py-1 shadow-[var(--wb-float-shadow)]"
    >
      {mode === "add" ? (
        <>
          <p className="px-3 pb-1 pt-1.5 text-xs text-[var(--wb-muted)]">{DESKTOP_ZH.addSection}</p>
          {MENTION_ADD_ORDER.map((id, index) => {
            const item = ADD_ITEMS.find((entry) => entry.id === id);
            if (!item) return null;
            const support = item.id === "goal" ? goalSupport : item.id === "plan" ? planSupport : "ready";
            const disabled = support !== "ready";
            const hint =
              item.id === "goal" && goalNotice
                ? goalNotice
                : item.id === "files"
                  ? ""
                  : supportHint(support, item.hint);
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === active}
                aria-disabled={disabled}
                data-mention-item={item.id}
                disabled={disabled}
                className={cn(
                  "flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left transition-colors",
                  disabled ? "cursor-not-allowed opacity-40" : "hover:bg-[var(--wb-hover)]",
                  index === active && !disabled && "bg-[var(--wb-hover-strong)]",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!disabled) onPick(item.id);
                }}
              >
                <AddIcon id={item.id} />
                <span className="shrink-0 text-sm text-[var(--wb-text-strong)]">{item.label}</span>
                {hint ? <span className="min-w-0 truncate text-xs text-[var(--wb-muted)]">{hint}</span> : null}
              </button>
            );
          })}
        </>
      ) : pending && files.length === 0 ? (
        <p className="px-3 py-2 text-xs text-[var(--wb-muted)]" data-mention-pending>
          {DESKTOP_ZH.mentionPending}
        </p>
      ) : error ? (
        <p className="px-3 py-2 text-xs text-[var(--wb-danger-text)]" data-mention-error>
          {error}
        </p>
      ) : files.length === 0 ? (
        <p className="px-3 py-2 text-xs text-[var(--wb-muted)]" data-mention-empty>
          {DESKTOP_ZH.mentionEmpty}
        </p>
      ) : (
        files.map((file, index) => (
          <button
            key={file.path}
            type="button"
            role="option"
            aria-selected={index === active}
            data-mention-file={file.path}
            className={cn(
              "flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-[var(--wb-hover)]",
              index === active && "bg-[var(--wb-hover-strong)]",
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onPick(file);
            }}
          >
            <File className="h-4 w-4 shrink-0 text-[var(--wb-muted)]" />
            <span className="min-w-0 shrink truncate text-sm text-[var(--wb-text-strong)]">
              {highlightParts(file.name, query).map((part, partIndex) =>
                part.match ? (
                  <mark key={partIndex} className="bg-transparent font-medium text-[var(--wb-accent)]">
                    {part.text}
                  </mark>
                ) : (
                  <span key={partIndex}>{part.text}</span>
                ),
              )}
            </span>
            {file.directory ? (
              <span className="min-w-0 truncate text-xs text-[var(--wb-muted)]">{file.directory}</span>
            ) : null}
          </button>
        ))
      )}
    </div>
  );
}

function AddIcon({ id }: { id: MentionAddId }) {
  const className = "h-4 w-4 shrink-0 text-[var(--wb-muted)]";
  if (id === "files") return <Folder className={className} />;
  if (id === "goal") return <Target className={className} />;
  return <Lightbulb className={className} />;
}
