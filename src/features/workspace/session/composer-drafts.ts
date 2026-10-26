// 作曲栏还没发出的东西：文字、附件、引用片段，新会话还有 Agent 和各项选项。
// 按会话 id（新会话是 `new:<项目>`）记在内存里，同时存进 daemon，切会话、重启都不丢。

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { daemon } from "@/lib/daemon";
import { createTextSnippet, withTextSnippet, type TextSnippet, type TextSnippetDraft } from "@/shared/text-snippet";
import type { AgentKind, Attachment, SessionSandbox, SessionTuning } from "@/types";

export interface ComposerDraft {
  text: string;
  files: Attachment[];
  snippets: TextSnippet[];
  /** 下面这些只有还没建好的新会话用。 */
  agent?: AgentKind;
  sandbox?: SessionSandbox | null;
  tuning?: SessionTuning | null;
  collaboration?: "plan" | "default";
  goal?: string | null;
  goalStatus?: "paused" | "active" | null;
  worktree?: boolean;
  followUpQueueMode?: "queue" | "steer";
}

const EMPTY: ComposerDraft = { text: "", files: [], snippets: [] };
const SAVE_DELAY_MS = 400;

const drafts = new Map<string, ComposerDraft>();
const loading = new Map<string, Promise<void>>();
const timers = new Map<string, number>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function isEmpty(draft: ComposerDraft): boolean {
  return (
    !draft.text &&
    draft.files.length === 0 &&
    draft.snippets.length === 0 &&
    draft.agent === undefined &&
    !draft.goal &&
    !draft.worktree &&
    draft.collaboration !== "plan" &&
    !draft.sandbox &&
    !draft.tuning
  );
}

function scheduleSave(key: string) {
  const pending = timers.get(key);
  if (pending !== undefined) window.clearTimeout(pending);
  timers.set(
    key,
    window.setTimeout(() => {
      timers.delete(key);
      const draft = drafts.get(key) ?? EMPTY;
      void daemon.call("drafts.set", { key, body: isEmpty(draft) ? null : draft }).catch(() => {});
    }, SAVE_DELAY_MS),
  );
}

/** 第一次用到时从 daemon 读回来。读不到就从空草稿开始。 */
function ensureLoaded(key: string): Promise<void> {
  if (drafts.has(key)) return Promise.resolve();
  let pending = loading.get(key);
  if (!pending) {
    pending = daemon
      .call<ComposerDraft | null>("drafts.get", { key })
      .then(
        (stored) => {
          if (!drafts.has(key)) drafts.set(key, { ...EMPTY, ...(stored ?? {}) });
        },
        () => {
          if (!drafts.has(key)) drafts.set(key, EMPTY);
        },
      )
      .finally(() => {
        loading.delete(key);
        emit();
      });
    loading.set(key, pending);
  }
  return pending;
}

export function readDraft(key: string): ComposerDraft {
  return drafts.get(key) ?? EMPTY;
}

export function patchDraft(key: string, patch: Partial<ComposerDraft>) {
  const current = drafts.get(key) ?? EMPTY;
  drafts.set(key, { ...current, ...patch });
  emit();
  scheduleSave(key);
}

/** 新会话建好后，它的草稿换到真正的会话 id 下；新会话那份清空。 */
export function moveDraft(from: string, to: string, keep: Partial<ComposerDraft>) {
  drafts.delete(from);
  drafts.set(to, { ...EMPTY, ...keep });
  emit();
  scheduleSave(from);
  scheduleSave(to);
}

export function addDraftAttachments(key: string, added: readonly Attachment[]) {
  void ensureLoaded(key).then(() => {
    const current = readDraft(key).files;
    const fresh = added.filter((file) => !current.some((item) => item.path === file.path));
    if (fresh.length > 0) patchDraft(key, { files: [...current, ...fresh] });
  });
}

export function addDraftSnippet(key: string, draft: TextSnippetDraft) {
  const snippet = createTextSnippet(draft);
  if (!snippet) return;
  void ensureLoaded(key).then(() => {
    patchDraft(key, { snippets: withTextSnippet(readDraft(key).snippets, snippet) });
  });
}

/** 这份草稿和它是否已经从 daemon 读回来。没读回来之前不挂作曲栏，免得把存下的字盖掉。 */
export function useComposerDraft(key: string): { draft: ComposerDraft; loaded: boolean } {
  useEffect(() => {
    void ensureLoaded(key);
  }, [key]);
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const draft = useSyncExternalStore(subscribe, () => readDraft(key));
  const loaded = useSyncExternalStore(subscribe, () => drafts.has(key));
  return { draft, loaded };
}
