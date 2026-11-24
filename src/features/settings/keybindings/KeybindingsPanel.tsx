import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Eraser,
  ExternalLink,
  Keyboard,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  KEYBINDING_COMMAND_BY_ID,
  detectShortcutPlatform,
  formatShortcutLabel,
  shortcutFromKeyboardEvent,
  validateWhenExpression,
  type KeybindingRule,
  type ShortcutPlatform,
} from "@/shared/keybindings";

import {
  KEYBINDINGS_PAGE,
  QUICK_WHEN_CHIPS,
  buildKeybindingDisplayRows,
  filterKeybindingRows,
  groupKeybindingRows,
  previewRecordingConflicts,
  resetCommandToDefault,
  setCommandShortcutAndWhen,
  unbindCommandShortcut,
  type KeybindingDisplayRow,
} from "./view";

export interface KeybindingsPanelProps {
  userRules: readonly KeybindingRule[];
  configPath: string;
  fileError?: string | null;
  actionError?: string | null;
  busy?: boolean;
  platform?: ShortcutPlatform;
  onSaveRules: (nextRules: KeybindingRule[]) => void | Promise<void>;
  onResetAll: () => void | Promise<void>;
  onOpenConfigFile: () => void | Promise<void>;
}

export function KeybindingsPanel({
  userRules,
  configPath,
  fileError = null,
  actionError = null,
  busy = false,
  platform = detectShortcutPlatform(),
  onSaveRules,
  onResetAll,
  onOpenConfigFile,
}: KeybindingsPanelProps) {
  const [query, setQuery] = useState("");
  const [onlyConflicts, setOnlyConflicts] = useState(false);
  const [onlyModified, setOnlyModified] = useState(false);

  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [recordedKey, setRecordedKey] = useState<string>("");

  const [editingWhenId, setEditingWhenId] = useState<string | null>(null);
  const [whenDraft, setWhenDraft] = useState<string>("");

  const captureRef = useRef<HTMLDivElement>(null);
  const whenInputRef = useRef<HTMLInputElement>(null);

  const { rows, conflictCount, modifiedCount } = useMemo(
    () => buildKeybindingDisplayRows(userRules, platform),
    [platform, userRules],
  );

  const filteredRows = useMemo(
    () => filterKeybindingRows(rows, { query, onlyConflicts, onlyModified }),
    [onlyConflicts, onlyModified, query, rows],
  );

  const sections = useMemo(() => groupKeybindingRows(filteredRows), [filteredRows]);

  useEffect(() => {
    if (recordingId) {
      captureRef.current?.focus();
    }
  }, [recordingId]);

  useEffect(() => {
    if (editingWhenId) {
      whenInputRef.current?.focus();
    }
  }, [editingWhenId]);

  useEffect(() => {
    if (recordingId !== null && !filteredRows.some((r) => r.id === recordingId)) {
      setRecordingId(null);
      setRecordedKey("");
    }
  }, [filteredRows, recordingId]);

  const recordingRow = recordingId
    ? (filteredRows.find((item) => item.id === recordingId) ?? null)
    : null;

  const commitRecordedShortcut = (row: KeybindingDisplayRow, keyToSave: string) => {
    const meta = KEYBINDING_COMMAND_BY_ID.get(row.id);
    if (!meta || !keyToSave.trim()) return;
    const whenToKeep = row.effectiveKey
      ? row.effectiveWhen || undefined
      : meta.defaultWhen || undefined;
    const next = setCommandShortcutAndWhen(userRules, meta, keyToSave, whenToKeep, platform);
    setRecordingId(null);
    setRecordedKey("");
    void onSaveRules(next);
  };

  useEffect(() => {
    if (!recordingRow) return;
    const onWindowKeyDown = (event: KeyboardEvent) => {
      const noMods = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if (noMods && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setRecordingId(null);
        setRecordedKey("");
        return;
      }
      if (noMods && event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (recordedKey && !busy) {
          commitRecordedShortcut(recordingRow, recordedKey);
        }
        return;
      }
      const nextChord = shortcutFromKeyboardEvent(event, platform);
      event.preventDefault();
      event.stopPropagation();
      if (nextChord) {
        setRecordedKey(nextChord);
      }
    };
    window.addEventListener("keydown", onWindowKeyDown, true);
    return () => window.removeEventListener("keydown", onWindowKeyDown, true);
  }, [busy, platform, recordedKey, recordingRow, userRules]);

  const startRecording = (row: KeybindingDisplayRow) => {
    setEditingWhenId(null);
    setRecordingId(row.id);
    setRecordedKey("");
  };

  const openWhenEditor = (row: KeybindingDisplayRow) => {
    if (!row.effectiveKey) return;
    setRecordingId(null);
    setRecordedKey("");
    setEditingWhenId((current) => (current === row.id ? null : row.id));
    setWhenDraft(row.effectiveWhen);
  };

  const whenValidation = useMemo(() => validateWhenExpression(whenDraft), [whenDraft]);

  const commitWhenEdit = (row: KeybindingDisplayRow) => {
    if (!row.effectiveKey || !whenValidation.valid) return;
    const meta = KEYBINDING_COMMAND_BY_ID.get(row.id);
    if (!meta) return;
    const next = setCommandShortcutAndWhen(
      userRules,
      meta,
      row.effectiveKey,
      whenValidation.normalized,
      platform,
    );
    setEditingWhenId(null);
    void onSaveRules(next);
  };

  const insertWhenChip = (expr: string) => {
    setWhenDraft((current) => {
      const trimmed = current.trim();
      if (!trimmed) return expr;
      if (trimmed === expr) return "";
      return `${trimmed} && ${expr}`;
    });
    whenInputRef.current?.focus();
  };

  const canResetAll = !busy && (userRules.length > 0 || Boolean(fileError));

  return (
    <section data-settings-panel="keybindings">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-wb-fg">{KEYBINDINGS_PAGE.title}</h2>
          <p className="mt-1 max-w-lg text-sm leading-6 text-wb-fg-2">{KEYBINDINGS_PAGE.subtitle}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-keybindings-open-json=""
            title={configPath || "keybindings.json"}
            disabled={busy || !configPath}
            onClick={() => void onOpenConfigFile()}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {KEYBINDINGS_PAGE.openJson}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-keybindings-reset-all=""
            disabled={!canResetAll}
            onClick={() => void onResetAll()}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {KEYBINDINGS_PAGE.resetAll}
          </Button>
        </div>
      </div>

      {fileError ? (
        <div
          role="alert"
          data-keybindings-file-error=""
          className="mt-4 flex items-start gap-2.5 rounded-xl border border-wb-danger/30 bg-wb-danger-soft px-3.5 py-2.5 text-xs leading-5 text-wb-danger"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">keybindings.json 解析错误，已回退到默认快捷键</div>
            <div className="mt-0.5 break-words opacity-90">{fileError}</div>
          </div>
        </div>
      ) : null}

      {actionError ? (
        <p
          role="alert"
          data-keybindings-action-error=""
          className="mt-3 rounded-xl border border-wb-danger/30 bg-wb-danger-soft px-3.5 py-2 text-xs text-wb-danger"
        >
          {actionError}
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-wb-fg-3"
            aria-hidden="true"
          />
          <input
            type="text"
            value={query}
            data-keybindings-search=""
            aria-label={KEYBINDINGS_PAGE.searchPlaceholder}
            placeholder={KEYBINDINGS_PAGE.searchPlaceholder}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 w-full rounded-lg border border-wb-border-strong bg-wb-input pl-8 pr-7 text-xs text-wb-fg outline-none transition-colors placeholder:text-wb-dim focus-visible:border-wb-accent focus-visible:ring-2 focus-visible:ring-wb-accent-soft"
          />
          {query ? (
            <button
              type="button"
              aria-label="清空搜索"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-wb-fg-3 hover:bg-wb-hover hover:text-wb-fg"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </div>

        <button
          type="button"
          data-keybindings-filter="conflicts"
          aria-pressed={onlyConflicts}
          onClick={() => setOnlyConflicts((v) => !v)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors",
            onlyConflicts
              ? "border-wb-warn/50 bg-wb-warn/15 font-medium text-wb-warn"
              : "border-wb-border bg-wb-elev text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
          )}
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{KEYBINDINGS_PAGE.filterConflicts}</span>
          {conflictCount > 0 ? (
            <span className="rounded-full bg-wb-warn/20 px-1.5 py-0.5 font-mono text-[10px] leading-none text-wb-warn">
              {conflictCount}
            </span>
          ) : null}
        </button>

        <button
          type="button"
          data-keybindings-filter="modified"
          aria-pressed={onlyModified}
          onClick={() => setOnlyModified((v) => !v)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors",
            onlyModified
              ? "border-wb-accent bg-wb-accent-soft font-medium text-wb-accent-ink"
              : "border-wb-border bg-wb-elev text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
          )}
        >
          <span>{KEYBINDINGS_PAGE.filterModified}</span>
          {modifiedCount > 0 ? (
            <span className="rounded-full bg-wb-accent/20 px-1.5 py-0.5 font-mono text-[10px] leading-none text-wb-accent-ink">
              {modifiedCount}
            </span>
          ) : null}
        </button>
      </div>

      {sections.length === 0 ? (
        <p data-keybindings-empty="" className="mt-8 text-center text-sm text-wb-fg-3">
          {KEYBINDINGS_PAGE.emptyMatch}
        </p>
      ) : (
        <div className="mt-5 space-y-6">
          {sections.map((section) => (
            <div key={section.group} data-keybindings-group={section.group}>
              <h3 className="wb-group-header mb-2 px-1">{section.label}</h3>
              <div className="divide-y divide-wb-border rounded-xl border border-wb-border bg-wb-elev">
                {section.rows.map((row) => {
                  const isRecording = recordingId === row.id;
                  const isEditingWhen = editingWhenId === row.id;
                  const meta = KEYBINDING_COMMAND_BY_ID.get(row.id);
                  const conflictTooltip =
                    row.conflictTitles.length > 0
                      ? `与以下快捷键冲突：${row.conflictTitles.join("、")}`
                      : undefined;
                  const liveRecordingConflicts =
                    isRecording && recordedKey && meta
                      ? previewRecordingConflicts(
                          userRules,
                          meta,
                          recordedKey,
                          row.effectiveKey
                            ? row.effectiveWhen || undefined
                            : meta.defaultWhen || undefined,
                          platform,
                        )
                      : [];

                  return (
                    <div
                      key={row.id}
                      data-keybinding-row={row.id}
                      className="px-3.5 py-2.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[13px] font-medium text-wb-fg">{row.title}</span>
                            {row.isCustomized ? (
                              <span
                                data-keybinding-customized={row.id}
                                className="rounded border border-wb-accent/30 bg-wb-accent-soft px-1.5 py-0.5 text-[10px] font-medium leading-none text-wb-accent-ink"
                              >
                                {KEYBINDINGS_PAGE.customizedBadge}
                              </span>
                            ) : null}
                            {row.conflictTitles.length > 0 ? (
                              <span
                                data-keybinding-conflict={row.id}
                                title={conflictTooltip}
                                className="inline-flex items-center gap-1 rounded border border-wb-warn/40 bg-wb-warn/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-wb-warn"
                              >
                                <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                                <span>冲突：{row.conflictTitles.join("、")}</span>
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-wb-fg-3">
                            <code className="font-mono">{row.id}</code>
                            {row.effectiveKey ? (
                              <button
                                type="button"
                                data-keybinding-when-trigger={row.id}
                                title={KEYBINDINGS_PAGE.editWhen}
                                disabled={busy}
                                onClick={() => openWhenEditor(row)}
                                className={cn(
                                  "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10.5px] leading-none transition-colors",
                                  row.effectiveWhen
                                    ? "border-wb-border bg-wb-surface text-wb-fg-2 hover:border-wb-border-strong hover:text-wb-fg"
                                    : "border-transparent text-wb-fg-3 hover:border-wb-border hover:bg-wb-surface hover:text-wb-fg-2",
                                )}
                              >
                                <SlidersHorizontal className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                                <span>{row.effectiveWhen || KEYBINDINGS_PAGE.alwaysActive}</span>
                              </button>
                            ) : null}
                          </div>
                        </div>

                        {isRecording ? (
                          <div
                            ref={captureRef}
                            tabIndex={0}
                            data-keybinding-recording="true"
                            data-keybinding-recorder={row.id}
                            className="flex flex-wrap items-center gap-2 rounded-lg border border-wb-accent bg-wb-surface px-2.5 py-1.5 outline-none ring-2 ring-wb-accent-soft"
                          >
                            <Keyboard className="h-3.5 w-3.5 shrink-0 text-wb-accent-ink" aria-hidden="true" />
                            {recordedKey ? (
                              <kbd
                                data-keybinding-recorded-preview=""
                                className="rounded border border-wb-accent/30 bg-wb-accent-soft px-1.5 py-0.5 font-mono text-xs font-medium text-wb-accent-ink"
                              >
                                {formatShortcutLabel(recordedKey, platform)}
                              </kbd>
                            ) : (
                              <span className="text-xs text-wb-fg-2">{KEYBINDINGS_PAGE.recordingPrompt}</span>
                            )}
                            <span className="text-[11px] text-wb-fg-3">{KEYBINDINGS_PAGE.recordingHint}</span>
                            {liveRecordingConflicts.length > 0 ? (
                              <span
                                data-keybinding-recording-conflict=""
                                className="inline-flex items-center gap-1 text-[11px] text-wb-warn"
                              >
                                <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                                <span>将与「{liveRecordingConflicts.join("、")}」冲突</span>
                              </span>
                            ) : null}
                            <button
                              type="button"
                              data-keybinding-record-save={row.id}
                              disabled={!recordedKey || busy}
                              onClick={() => commitRecordedShortcut(row, recordedKey)}
                              className="inline-flex items-center gap-1 rounded bg-wb-accent px-2 py-0.5 text-xs font-medium text-white disabled:opacity-40"
                            >
                              <Check className="h-3 w-3" />
                              <span>保存</span>
                            </button>
                            <button
                              type="button"
                              data-keybinding-record-cancel={row.id}
                              onClick={() => {
                                setRecordingId(null);
                                setRecordedKey("");
                              }}
                              className="rounded px-1.5 py-0.5 text-xs text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg"
                            >
                              取消
                            </button>
                          </div>
                        ) : (
                          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                            {row.shortcutLabel ? (
                              <div className="flex items-center gap-1">
                                <kbd
                                  data-keybinding-kbd={row.id}
                                  className="rounded border border-wb-border bg-wb-surface px-2 py-0.5 font-mono text-xs text-wb-fg"
                                >
                                  {row.shortcutLabel}
                                </kbd>
                                {row.secondaryLabels.map((extra) => (
                                  <kbd
                                    key={extra}
                                    className="rounded border border-wb-border bg-wb-surface/70 px-1.5 py-0.5 font-mono text-[11px] text-wb-fg-2"
                                  >
                                    {extra}
                                  </kbd>
                                ))}
                              </div>
                            ) : (
                              <span
                                data-keybinding-unbound={row.id}
                                className="px-1.5 text-xs text-wb-fg-3"
                              >
                                {KEYBINDINGS_PAGE.unbound}
                              </span>
                            )}

                            <button
                              type="button"
                              data-keybinding-record={row.id}
                              disabled={busy}
                              onClick={() => startRecording(row)}
                              className="inline-flex h-7 items-center gap-1 rounded-md border border-wb-border bg-wb-surface px-2 text-xs text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg disabled:opacity-50"
                            >
                              <Keyboard className="h-3 w-3" aria-hidden="true" />
                              <span>{KEYBINDINGS_PAGE.record}</span>
                            </button>

                            {row.effectiveKey && meta ? (
                              <button
                                type="button"
                                data-keybinding-clear={row.id}
                                title={KEYBINDINGS_PAGE.clearShortcut}
                                aria-label={`${row.title} ${KEYBINDINGS_PAGE.clearShortcut}`}
                                disabled={busy}
                                onClick={() => void onSaveRules(unbindCommandShortcut(userRules, meta))}
                                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-fg disabled:opacity-50"
                              >
                                <Eraser className="h-3 w-3" aria-hidden="true" />
                                <span>{KEYBINDINGS_PAGE.clearShortcut}</span>
                              </button>
                            ) : null}

                            {row.isCustomized ? (
                              <button
                                type="button"
                                data-keybinding-reset={row.id}
                                title={KEYBINDINGS_PAGE.resetCommand}
                                aria-label={`${row.title} ${KEYBINDINGS_PAGE.resetCommand}`}
                                disabled={busy}
                                onClick={() => void onSaveRules(resetCommandToDefault(userRules, row.id))}
                                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg disabled:opacity-50"
                              >
                                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                                <span>{KEYBINDINGS_PAGE.resetCommand}</span>
                              </button>
                            ) : null}
                          </div>
                        )}
                      </div>

                      {isEditingWhen ? (
                        <div
                          data-keybinding-when-editor={row.id}
                          className="mt-2.5 rounded-lg border border-wb-border bg-wb-surface p-2.5"
                        >
                          <div className="flex items-center gap-2">
                            <input
                              ref={whenInputRef}
                              type="text"
                              value={whenDraft}
                              data-keybinding-when-input={row.id}
                              aria-label={`${row.title} when 条件`}
                              placeholder="留空表示全局生效，例如 !terminalFocus && sessionActive"
                              onChange={(event) => setWhenDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  setEditingWhenId(null);
                                  return;
                                }
                                if (event.key === "Enter" && whenValidation.valid) {
                                  event.preventDefault();
                                  commitWhenEdit(row);
                                }
                              }}
                              className={cn(
                                "h-7 min-w-0 flex-1 rounded border bg-wb-input px-2.5 font-mono text-xs text-wb-fg outline-none",
                                whenValidation.valid
                                  ? "border-wb-border-strong focus-visible:border-wb-accent"
                                  : "border-wb-danger focus-visible:border-wb-danger",
                              )}
                            />
                            <Button
                              type="button"
                              size="sm"
                              data-keybinding-when-save={row.id}
                              disabled={!whenValidation.valid || busy}
                              onClick={() => commitWhenEdit(row)}
                            >
                              保存条件
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              data-keybinding-when-cancel={row.id}
                              onClick={() => setEditingWhenId(null)}
                            >
                              取消
                            </Button>
                          </div>

                          {!whenValidation.valid && whenValidation.error ? (
                            <p data-keybinding-when-error="" className="mt-1.5 text-xs text-wb-danger">
                              {whenValidation.error}
                            </p>
                          ) : null}

                          <div className="mt-2 flex flex-wrap items-center gap-1">
                            <span className="mr-1 text-[11px] text-wb-fg-3">常用变量：</span>
                            {QUICK_WHEN_CHIPS.map((chip) => (
                              <button
                                key={chip.expr}
                                type="button"
                                data-keybinding-when-chip={chip.expr}
                                onClick={() => insertWhenChip(chip.expr)}
                                className="rounded border border-wb-border bg-wb-elev px-1.5 py-0.5 font-mono text-[10.5px] text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
                              >
                                {chip.label}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
