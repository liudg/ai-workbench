import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ChevronLeft } from "lucide-react";

import { userFacingMessage } from "@/lib/user-facing";
import { cn } from "@/lib/utils";
import type { ReviewStart, ReviewTargets } from "@/types";

type Step = "presets" | "branch" | "commit" | "custom";

/**
 * 审查菜单。层级和文案跟着适配器给的 `labels`（Codex 取自 TUI `review_popups.rs`）：
 * 预设 → 选基础分支 / 选提交 / 自定义说明。
 */
export function ReviewMenu({
  sessionId,
  loadTargets,
  onStart,
}: {
  sessionId: string;
  loadTargets: (sessionId: string) => Promise<ReviewTargets>;
  onStart: (target: ReviewStart) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [targets, setTargets] = useState<ReviewTargets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("presets");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void loadTargets(sessionId)
      .then((next) => !cancelled && setTargets(next))
      .catch((err) => !cancelled && setError(userFacingMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [loadTargets, sessionId]);

  const labels = targets?.labels;
  useEffect(() => {
    if (labels && step === "presets") {
      menuRef.current?.focus();
    }
  }, [labels, step]);

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLElement>('[data-review-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, step, query]);
  const open = (next: Step) => {
    setQuery("");
    setActive(0);
    setStep(next);
  };
  const needle = query.trim().toLowerCase();
  const filteredBranches = targets ? targets.branches.filter((branch) => branch.toLowerCase().includes(needle)) : [];
  const filteredCommits = targets
    ? targets.commits.filter((commit) => `${commit.title} ${commit.sha}`.toLowerCase().includes(needle))
    : [];

  const handleListKeys = (count: number, runAt: (idx: number) => void) => (event: ReactKeyboardEvent) => {
    if (count <= 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((idx) => (idx + 1) % count);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((idx) => (idx - 1 + count) % count);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      runAt(Math.min(active, count - 1));
    }
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-label={labels?.title ?? "审查"}
      className="wb-popover absolute bottom-full left-0 right-0 z-20 mb-2 max-h-80 min-w-0 space-y-0.5 overflow-x-hidden overflow-y-auto rounded-xl p-1.5 outline-none"
      onKeyDown={
        labels && step === "presets"
          ? handleListKeys(4, (idx) => {
              if (idx === 0) open("branch");
              else if (idx === 1) onStart({ kind: "uncommitted" });
              else if (idx === 2) open("commit");
              else open("custom");
            })
          : undefined
      }
    >
      {error && <p className="px-2.5 py-2 text-xs text-wb-danger">{error}</p>}
      {!labels && !error && <p className="px-2.5 py-2 text-xs text-wb-fg-3">正在读取…</p>}
      {labels && step === "presets" && (
        <>
          <p className="wb-group-header px-2.5 pb-1 pt-1">{labels.title}</p>
          <Row
            label={labels.base_branch}
            hint={labels.base_branch_hint}
            selected={active === 0}
            onHover={() => setActive(0)}
            onPick={() => open("branch")}
          />
          <Row
            label={labels.uncommitted}
            selected={active === 1}
            onHover={() => setActive(1)}
            onPick={() => onStart({ kind: "uncommitted" })}
          />
          <Row
            label={labels.commit}
            selected={active === 2}
            onHover={() => setActive(2)}
            onPick={() => open("commit")}
          />
          <Row
            label={labels.custom}
            selected={active === 3}
            onHover={() => setActive(3)}
            onPick={() => open("custom")}
          />
        </>
      )}
      {labels && step === "branch" && (
        <>
          <StepHeader title={labels.branch_title} subtitle={labels.branch_subtitle} onBack={() => open("presets")} />
          <Search
            value={query}
            placeholder={labels.branch_search}
            onChange={(next) => {
              setQuery(next);
              setActive(0);
            }}
            onKeyDown={handleListKeys(filteredBranches.length, (idx) => {
              const branch = filteredBranches[idx];
              if (branch) onStart({ kind: "base", branch });
            })}
          />
          {filteredBranches.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-wb-fg-3">没有匹配的分支</p>
          ) : (
            filteredBranches.map((branch, idx) => (
              <Row
                key={branch}
                label={branch}
                selected={idx === active}
                onHover={() => setActive(idx)}
                onPick={() => onStart({ kind: "base", branch })}
              />
            ))
          )}
        </>
      )}
      {labels && step === "commit" && (
        <>
          <StepHeader title={labels.commit_title} onBack={() => open("presets")} />
          <Search
            value={query}
            placeholder={labels.commit_search}
            onChange={(next) => {
              setQuery(next);
              setActive(0);
            }}
            onKeyDown={handleListKeys(filteredCommits.length, (idx) => {
              const commit = filteredCommits[idx];
              if (commit) onStart({ kind: "commit", sha: commit.sha, title: commit.title });
            })}
          />
          {filteredCommits.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-wb-fg-3">没有匹配的提交</p>
          ) : (
            filteredCommits.map((commit, idx) => (
              <Row
                key={commit.sha}
                label={commit.title}
                hint={commit.sha.slice(0, 7)}
                monoHint
                selected={idx === active}
                onHover={() => setActive(idx)}
                onPick={() => onStart({ kind: "commit", sha: commit.sha, title: commit.title })}
              />
            ))
          )}
        </>
      )}
      {labels && step === "custom" && (
        <form
          className="px-2.5 py-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const instructions = query.trim();
            if (instructions) onStart({ kind: "custom", instructions });
          }}
        >
          <StepHeader title={labels.custom} compact onBack={() => open("presets")} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={labels.custom_placeholder}
            aria-label={labels.custom}
            className="mt-1 h-8 w-full min-w-0 rounded-lg border border-wb-border-strong bg-wb-input px-2.5 text-[13px] text-wb-fg outline-none transition-colors placeholder:text-wb-dim focus-visible:border-wb-accent focus-visible:ring-2 focus-visible:ring-wb-accent-soft"
          />
        </form>
      )}
    </div>
  );
}

function StepHeader({
  title,
  subtitle,
  compact = false,
  onBack,
}: {
  title: string;
  subtitle?: string;
  compact?: boolean;
  onBack: () => void;
}) {
  return (
    <div className={cn("pb-1 pt-0.5", !compact && "px-2.5")}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-wb-fg">{title}</span>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-wb-border bg-wb-elev/70 px-2 py-0.5 text-xs font-medium text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
          onClick={onBack}
        >
          <ChevronLeft className="h-3 w-3" aria-hidden="true" />
          返回
        </button>
      </div>
      {subtitle ? <p className="mt-0.5 text-xs text-wb-fg-3">{subtitle}</p> : null}
    </div>
  );
}

function Row({
  label,
  hint,
  monoHint = false,
  selected = false,
  onHover,
  onPick,
}: {
  label: string;
  hint?: string;
  monoHint?: boolean;
  selected?: boolean;
  onHover?: () => void;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-review-active={selected ? "true" : undefined}
      className={cn(
        "flex w-full min-w-0 items-baseline justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-5 text-wb-fg transition-colors",
        selected ? "wb-menu-active font-medium" : "hover:bg-wb-hover",
      )}
      onMouseEnter={onHover}
      onMouseDown={(event) => {
        event.preventDefault();
        onPick();
      }}
    >
      <span className="min-w-0 break-words">{label}</span>
      {hint ? (
        <span className={cn("shrink-0 text-xs text-wb-fg-3", monoHint && "font-mono")}>{hint}</span>
      ) : null}
    </button>
  );
}

function Search({
  value,
  placeholder,
  onChange,
  onKeyDown,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: ReactKeyboardEvent) => void;
}) {
  return (
    <div className="px-2.5 pb-1">
      <input
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-8 w-full min-w-0 rounded-lg border border-wb-border-strong bg-wb-input px-2.5 text-[13px] text-wb-fg outline-none transition-colors placeholder:text-wb-dim focus-visible:border-wb-accent focus-visible:ring-2 focus-visible:ring-wb-accent-soft"
      />
    </div>
  );
}
