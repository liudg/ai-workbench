// 任务作曲栏还没发出的附件和引用片段。面板里的「附到对话」「引用到对话」、作曲栏自己的选文件和粘贴
// 都往这里放，切任务不丢。

import { useCallback, useSyncExternalStore } from "react";

import {
  createTextSnippet,
  withTextSnippet,
  type TextSnippet,
  type TextSnippetDraft,
} from "@/shared/text-snippet";
import type { Attachment } from "@/types";

const NO_FILES: Attachment[] = [];
const NO_SNIPPETS: TextSnippet[] = [];
const files = new Map<string, Attachment[]>();
const snippets = new Map<string, TextSnippet[]>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function put<T>(map: Map<string, T[]>, sessionId: string, list: T[]) {
  if (list.length === 0) map.delete(sessionId);
  else map.set(sessionId, list);
  emit();
}

export function addTaskAttachments(sessionId: string, added: readonly Attachment[]) {
  const current = files.get(sessionId) ?? NO_FILES;
  const fresh = added.filter((file) => !current.some((item) => item.path === file.path));
  if (fresh.length > 0) put(files, sessionId, [...current, ...fresh]);
}

export function setTaskAttachments(sessionId: string, list: Attachment[]) {
  put(files, sessionId, list);
}

export function useTaskAttachments(sessionId: string): Attachment[] {
  const read = useCallback(() => files.get(sessionId) ?? NO_FILES, [sessionId]);
  return useSyncExternalStore(subscribe, read);
}

export function addTaskSnippet(sessionId: string, draft: TextSnippetDraft) {
  const snippet = createTextSnippet(draft);
  if (!snippet) return;
  put(snippets, sessionId, withTextSnippet(snippets.get(sessionId) ?? NO_SNIPPETS, snippet));
}

export function setTaskSnippets(sessionId: string, list: TextSnippet[]) {
  put(snippets, sessionId, list);
}

export function clearTaskSnippets(sessionId: string) {
  put(snippets, sessionId, []);
}

export function useTaskSnippets(sessionId: string): TextSnippet[] {
  const read = useCallback(() => snippets.get(sessionId) ?? NO_SNIPPETS, [sessionId]);
  return useSyncExternalStore(subscribe, read);
}
