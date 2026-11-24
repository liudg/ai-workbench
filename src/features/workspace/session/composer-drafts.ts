// 作曲栏还没发出的东西：文字、附件、引用片段，新会话还有 Agent 和各项选项。
// 按会话 id（新会话是 `new:<项目>`）记在内存里，同时存进 daemon，切会话、重启都不丢。

import { useEffect, useSyncExternalStore } from "react";

import type { SelectableInstance } from "@/features/agents";
import type { AgentOption, ComposerHost, FileRef } from "@/features/chat/headless";
import { daemon } from "@/lib/daemon";
import { agentIdentity, profileForSessionAgent } from "@/shared/agent/identity";
import {
  createTextSnippet,
  withoutTextSnippet,
  withTextSnippet,
  type TextSnippet,
  type TextSnippetDraft,
} from "@/shared/text-snippet";
import type {
  AgentKind,
  AgentProfile,
  Attachment,
  QueuedTurn,
  SessionSandbox,
  SessionTuning,
} from "@/types";
import { withQueuedDraft } from "./queued-draft";

export interface ComposerDraft {
  text: string;
  /** 框里 `@文件名` 对应的完整路径。 */
  fileRefs?: FileRef[];
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
  /** 工作树的起点分支。为空时用项目目录现在所在的分支。 */
  worktreeBase?: string | null;
  /** 把项目目录里没提交的改动带进工作树。 */
  carryChanges?: boolean;
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

/** 先从 daemon 加载草稿，再读取当前未发送的文字。 */
export async function loadDraftText(key: string): Promise<string> {
  await ensureLoaded(key);
  return readDraft(key).text;
}

/** 先确保草稿已加载，再安全写入草稿文字（仅填入作曲栏草稿，绝不自动发送；覆盖草稿时清空旧的 `@` 引用与片段）。 */
export async function setDraftText(key: string, text: string): Promise<void> {
  await ensureLoaded(key);
  patchDraft(key, { text, fileRefs: [], snippets: [] });
}

/** 回退后把撤回的用户文字与附件/图片还原进对应会话的作曲栏草稿。 */
export async function restoreRewoundDraft(
  key: string,
  restored: { text: string; files: readonly Attachment[] },
): Promise<void> {
  await ensureLoaded(key);
  patchDraft(key, {
    text: restored.text,
    files: [...restored.files],
    fileRefs: [],
    snippets: [],
  });
}

export async function appendQueuedDraft(key: string, item: QueuedTurn, remove: () => Promise<unknown>) {
  await ensureLoaded(key);
  await remove();
  patchDraft(key, withQueuedDraft(readDraft(key), item));
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

/** 会话不在了（侧边聊天关掉），它没发的东西一起丢掉。 */
export function dropDraft(key: string) {
  if (!drafts.delete(key)) return;
  emit();
  scheduleSave(key);
}

function mergeUniqueAttachments(
  current: readonly Attachment[],
  added: readonly Attachment[],
): Attachment[] | null {
  const fresh = added.filter((file) => !current.some((item) => item.path === file.path));
  return fresh.length > 0 ? [...current, ...fresh] : null;
}

export function addDraftAttachments(key: string, added: readonly Attachment[]) {
  void ensureLoaded(key).then(() => {
    const merged = mergeUniqueAttachments(readDraft(key).files, added);
    if (merged) patchDraft(key, { files: merged });
  });
}

export function addDraftSnippet(key: string, draft: TextSnippetDraft) {
  const snippet = createTextSnippet(draft);
  if (!snippet) return;
  void ensureLoaded(key).then(() => {
    patchDraft(key, { snippets: withTextSnippet(readDraft(key).snippets, snippet) });
  });
}

/** 没送出去的引用放回原位，排在之后新加的前面。 */
export function restoreDraftSnippets(key: string, snippets: readonly TextSnippet[]) {
  const current = readDraft(key).snippets;
  const missing = snippets.filter((snippet) => !current.some((item) => item.id === snippet.id));
  if (missing.length > 0) patchDraft(key, { snippets: [...missing, ...current] });
}

export function removeDraftSnippet(key: string, id: string) {
  const current = readDraft(key).snippets;
  const next = withoutTextSnippet(current, id);
  if (next !== current) patchDraft(key, { snippets: next });
}

/** 任何草稿变了都会通知。 */
export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 这份草稿和它是否已经从 daemon 读回来。没读回来之前不挂作曲栏，免得把存下的字盖掉。 */
export function useComposerDraft(key: string): { draft: ComposerDraft; loaded: boolean } {
  useEffect(() => {
    void ensureLoaded(key);
  }, [key]);
  const subscribe = subscribeDrafts;
  const draft = useSyncExternalStore(subscribe, () => readDraft(key));
  const loaded = useSyncExternalStore(subscribe, () => drafts.has(key));
  return { draft, loaded };
}

export function selectableToAgentOption(
  item: SelectableInstance,
  profiles: Partial<Record<string, AgentProfile>>,
): AgentOption {
  const itemProfile = profileForSessionAgent(item.kind, profiles, item.instanceId);
  return {
    kind: item.kind,
    instanceId: item.instanceId,
    accentColor: item.accentColor,
    isDefault: item.isDefault,
    name: item.displayName,
    identity: agentIdentity(item.kind, itemProfile),
  };
}

/** 新建草稿作曲栏与建好的会话作曲栏共用的草稿读写回调。 */
export function composerDraftHostActions(
  key: string,
): Pick<
  ComposerHost,
  | "rememberText"
  | "rememberFileRefs"
  | "addAttachments"
  | "removeAttachment"
  | "clearAttachments"
  | "replaceAttachments"
  | "clearTextSnippets"
  | "restoreTextSnippets"
  | "removeTextSnippet"
> {
  return {
    rememberText: (text, expected) => {
      const current = readDraft(key).text;
      if (expected !== undefined && current !== expected) return;
      if (current !== text) patchDraft(key, { text });
    },
    rememberFileRefs: (fileRefs) => patchDraft(key, { fileRefs }),
    addAttachments: (files) => {
      const merged = mergeUniqueAttachments(readDraft(key).files, files);
      if (merged) patchDraft(key, { files: merged });
    },
    removeAttachment: (path) =>
      patchDraft(key, { files: readDraft(key).files.filter((file) => file.path !== path) }),
    clearAttachments: () => patchDraft(key, { files: [] }),
    replaceAttachments: (files) => patchDraft(key, { files }),
    clearTextSnippets: () => patchDraft(key, { snippets: [] }),
    restoreTextSnippets: (snippets) => restoreDraftSnippets(key, snippets),
    removeTextSnippet: (id) => removeDraftSnippet(key, id),
  };
}
