import { useState } from "react";
import { Search as SearchIcon } from "lucide-react";

import type { ReviewStart } from "@/types";
import { useReviewTargets } from "./useReviewTargets";

type Step = "presets" | "branch" | "commit" | "custom";

const fieldClass =
  "h-8 w-full min-w-0 rounded-lg border border-[var(--wb-border-strong)] bg-[var(--wb-well)] px-2.5 text-sm text-[var(--wb-text-strong)] outline-none transition-colors placeholder:text-[var(--wb-muted)] focus:border-[var(--wb-accent)] focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/20";

/**
 * 审查菜单。层级和文案跟着适配器给的 `labels`（Codex 取自 TUI `review_popups.rs`）：
 * 预设 → 选基础分支 / 选提交 / 自定义说明。
 */
export function ReviewMenu({
  sessionId,
  onStart,
}: {
  sessionId: string;
  onStart: (target: ReviewStart) => void;
}) {
  const { targets, error } = useReviewTargets(sessionId);
  const [step, setStep] = useState<Step>("presets");
  const [query, setQuery] = useState("");

  const labels = targets?.labels;
  const open = (next: Step) => {
    setQuery("");
    setStep(next);
  };
  const needle = query.trim().toLowerCase();

  return (
    <div
      role="menu"
      aria-label={labels?.title ?? "review"}
      className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-80 min-w-0 overflow-x-hidden overflow-y-auto rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] py-1 shadow-[var(--wb-float-shadow)]"
    >
      {error && <p className="px-3 py-2 text-xs text-[var(--wb-danger-text)]">{error}</p>}
      {!labels && !error && <p className="px-3 py-2 text-xs text-[var(--wb-muted)]">…</p>}
      {labels && step === "presets" && (
        <>
          <p className="px-3 pb-1 pt-2 text-xs font-medium text-[var(--wb-text-strong)]">{labels.title}</p>
          <Row label={labels.base_branch} hint={labels.base_branch_hint} onPick={() => open("branch")} />
          <Row label={labels.uncommitted} onPick={() => onStart({ kind: "uncommitted" })} />
          <Row label={labels.commit} onPick={() => open("commit")} />
          <Row label={labels.custom} onPick={() => open("custom")} />
        </>
      )}
      {labels && step === "branch" && (
        <>
          <p className="px-3 pt-2 text-xs font-medium text-[var(--wb-text-strong)]">{labels.branch_title}</p>
          <p className="px-3 pb-1.5 text-[11px] text-[var(--wb-muted)]">{labels.branch_subtitle}</p>
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
          <p className="px-3 pb-1.5 pt-2 text-xs font-medium text-[var(--wb-text-strong)]">{labels.commit_title}</p>
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
          className="px-3 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            const instructions = query.trim();
            if (instructions) onStart({ kind: "custom", instructions });
          }}
        >
          <p className="pb-1.5 text-xs font-medium text-[var(--wb-text-strong)]">{labels.custom}</p>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={labels.custom_placeholder}
            aria-label={labels.custom}
            className={fieldClass}
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
      className="flex w-full min-w-0 items-baseline gap-2 px-3 py-1.5 text-left text-sm text-[var(--wb-text-strong)] transition-colors hover:bg-[var(--wb-hover)]"
      onMouseDown={(event) => {
        event.preventDefault();
        onPick();
      }}
    >
      <span className="min-w-0 break-words">{label}</span>
      {hint && <span className="shrink-0 text-xs text-[var(--wb-muted)]">{hint}</span>}
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
    <div className="mb-1 flex items-center gap-2 border-y border-[var(--wb-border)] px-3 py-1.5">
      <SearchIcon className="h-3.5 w-3.5 shrink-0 text-[var(--wb-faint)]" />
      <input
        autoFocus
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full min-w-0 bg-transparent text-sm text-[var(--wb-text-strong)] outline-none placeholder:text-[var(--wb-faint)]"
      />
    </div>
  );
}
