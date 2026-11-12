import { useEffect, useState } from "react";

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
  const [targets, setTargets] = useState<ReviewTargets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("presets");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    void loadTargets(sessionId)
      .then((next) => !cancelled && setTargets(next))
      .catch((err) => !cancelled && setError(String(err)));
    return () => {
      cancelled = true;
    };
  }, [loadTargets, sessionId]);

  const labels = targets?.labels;
  const open = (next: Step) => {
    setQuery("");
    setStep(next);
  };
  const needle = query.trim().toLowerCase();

  return (
    <div
      role="menu"
      aria-label={labels?.title ?? "审查"}
      className="wb-popover absolute bottom-full left-0 right-0 z-20 mb-2 max-h-80 min-w-0 overflow-x-hidden overflow-y-auto rounded-xl p-1"
    >
      {error && <p className="px-2.5 py-2 text-xs text-wb-danger">{error}</p>}
      {!labels && !error && <p className="px-2.5 py-2 text-xs text-wb-fg-3">…</p>}
      {labels && step === "presets" && (
        <>
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-wb-fg-3">{labels.title}</p>
          <Row label={labels.base_branch} hint={labels.base_branch_hint} onPick={() => open("branch")} />
          <Row label={labels.uncommitted} onPick={() => onStart({ kind: "uncommitted" })} />
          <Row label={labels.commit} onPick={() => open("commit")} />
          <Row label={labels.custom} onPick={() => open("custom")} />
        </>
      )}
      {labels && step === "branch" && (
        <>
          <p className="px-2.5 pt-1.5 text-xs font-medium text-wb-fg">{labels.branch_title}</p>
          <p className="px-2.5 pb-1 text-[11px] text-wb-fg-3">{labels.branch_subtitle}</p>
          <Search value={query} placeholder={labels.branch_search} onChange={setQuery} />
          {targets.branches
            .filter((branch) => branch.toLowerCase().includes(needle))
            .map((branch) => (
              <Row key={branch} label={branch} onPick={() => onStart({ kind: "base", branch })} />
            ))}
        </>
      )}
      {labels && step === "commit" && (
        <>
          <p className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-wb-fg">{labels.commit_title}</p>
          <Search value={query} placeholder={labels.commit_search} onChange={setQuery} />
          {targets.commits
            .filter((commit) => `${commit.title} ${commit.sha}`.toLowerCase().includes(needle))
            .map((commit) => (
              <Row
                key={commit.sha}
                label={commit.title}
                onPick={() => onStart({ kind: "commit", sha: commit.sha, title: commit.title })}
              />
            ))}
        </>
      )}
      {labels && step === "custom" && (
        <form
          className="px-2.5 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            const instructions = query.trim();
            if (instructions) onStart({ kind: "custom", instructions });
          }}
        >
          <p className="pb-1 text-xs font-medium text-wb-fg">{labels.custom}</p>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={labels.custom_placeholder}
            aria-label={labels.custom}
            className="h-8 w-full min-w-0 rounded-lg border border-wb-border-strong bg-wb-input px-2.5 text-sm text-wb-fg outline-none transition-colors placeholder:text-wb-dim focus-visible:border-wb-accent focus-visible:ring-2 focus-visible:ring-wb-accent-soft"
          />
        </form>
      )}
    </div>
  );
}

function Row({ label, hint, onPick }: { label: string; hint?: string; onPick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      className="flex w-full min-w-0 items-baseline gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-wb-fg transition-colors hover:bg-wb-hover"
      onMouseDown={(event) => {
        event.preventDefault();
        onPick();
      }}
    >
      <span className="min-w-0 break-words">{label}</span>
      {hint && <span className="shrink-0 text-xs text-wb-fg-3">{hint}</span>}
    </button>
  );
}

function Search({
  value,
  placeholder,
  onChange,
}: {
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="px-2.5 pb-1">
      <input
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-8 w-full min-w-0 rounded-lg border border-wb-border-strong bg-wb-input px-2.5 text-sm text-wb-fg outline-none transition-colors placeholder:text-wb-dim focus-visible:border-wb-accent focus-visible:ring-2 focus-visible:ring-wb-accent-soft"
      />
    </div>
  );
}
