import { File, Folder, Lightbulb, Target } from "lucide-react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import {
  highlightParts,
  type MentionAddId,
  type MentionFile,
  type MentionSupport,
} from "./mentions";
import { SuggestionList } from "./SuggestionList";

export type { MentionAddId };

const ADD_ITEMS: { id: MentionAddId; label: string; hint: string }[] = [
  { id: "files", label: DESKTOP_ZH.addFiles, hint: "" },
  { id: "goal", label: DESKTOP_ZH.goalLabel, hint: DESKTOP_ZH.goalHint },
  { id: "plan", label: DESKTOP_ZH.planTitle, hint: DESKTOP_ZH.planOn },
];

function supportHint(support: MentionSupport, hint: string): string {
  return support === "loading" ? DESKTOP_ZH.mentionLoadingCaps : hint;
}

export function MentionMenu({
  mode,
  items,
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
  /** 添加菜单里列出的项，不支持的已去掉。 */
  items: readonly MentionAddId[];
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
    <SuggestionList label={mode === "add" ? DESKTOP_ZH.addSection : "文件"} active={active} data-mention-menu={mode}>
      {mode === "add" ? (
        <>
          <p className="px-3 pb-1 pt-1.5 text-[11px] font-medium text-wb-fg-3">{DESKTOP_ZH.addSection}</p>
          {items.map((id, index) => {
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
                  disabled ? "cursor-not-allowed opacity-40" : "hover:bg-wb-hover",
                  index === active && !disabled && "bg-wb-active",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!disabled) onPick(item.id);
                }}
              >
                <AddIcon id={item.id} />
                <span className="shrink-0 text-sm text-wb-fg">{item.label}</span>
                {hint ? <span className="min-w-0 truncate text-xs text-wb-fg-3">{hint}</span> : null}
              </button>
            );
          })}
        </>
      ) : pending && files.length === 0 ? (
        <p className="px-3 py-2 text-xs text-wb-fg-3" data-mention-pending>
          {DESKTOP_ZH.mentionPending}
        </p>
      ) : error ? (
        <p className="px-3 py-2 text-xs text-wb-danger" data-mention-error>
          {error}
        </p>
      ) : files.length === 0 ? (
        <p className="px-3 py-2 text-xs text-wb-fg-3" data-mention-empty>
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
              "flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-wb-hover",
              index === active && "bg-wb-active",
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onPick(file);
            }}
          >
            <File className="h-4 w-4 shrink-0 text-wb-fg-3" />
            <span className="min-w-0 shrink truncate text-sm text-wb-fg">
              {highlightParts(file.name, query).map((part, partIndex) =>
                part.match ? (
                  <mark key={partIndex} className="bg-transparent font-medium text-wb-accent">
                    {part.text}
                  </mark>
                ) : (
                  <span key={partIndex}>{part.text}</span>
                ),
              )}
            </span>
            {file.directory ? (
              <span className="min-w-0 truncate text-xs text-wb-fg-3">{file.directory}</span>
            ) : null}
          </button>
        ))
      )}
    </SuggestionList>
  );
}

function AddIcon({ id }: { id: MentionAddId }) {
  const className = "h-4 w-4 shrink-0 text-wb-fg-3";
  if (id === "files") return <Folder className={className} />;
  if (id === "goal") return <Target className={className} />;
  return <Lightbulb className={className} />;
}
