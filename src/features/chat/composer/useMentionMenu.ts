import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import type { MentionSupport } from "./mentions";
import {
  caretAfterMentionPick,
  clearAtToken,
  insertMention,
  mentionPickText,
  mentionAddEnabled,
  MENTION_ADD_ORDER,
  type MentionAddId,
  type MentionFile,
} from "./mentions";
import { pickFiles as pickLocalFiles } from "@/lib/native/pick-files";
import { stepIndex } from "./composer-keys";
import type { ComposerHost } from "./host";
import { useMentionSearch } from "./useMentionSearch";

function placeCaret(textarea: HTMLTextAreaElement | null, caret: number) {
  requestAnimationFrame(() => {
    textarea?.focus();
    textarea?.setSelectionRange(caret, caret);
  });
}

/** `@` 菜单：空查询是添加项，有查询时用工作区路径筛选。 */
export function useMentionMenu(input: {
  host: ComposerHost;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  caret: number;
  setCaret: Dispatch<SetStateAction<number>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  mentionOpen: boolean;
  mentionAdd: boolean;
  mentionQuery: string | null;
  goalSupport: MentionSupport;
  planSupport: MentionSupport;
  onGoal: () => void;
  onPlan: () => void;
}) {
  const [hidden, setHidden] = useState(false);
  const [index, setIndex] = useState(0);
  const textRef = useRef(input.text);
  textRef.current = input.text;
  const searchQuery = input.mentionOpen && !hidden && input.mentionQuery ? input.mentionQuery : null;
  const search = useMentionSearch(input.host, searchQuery);
  const show = input.mentionOpen && !hidden;
  const activeAdd = MENTION_ADD_ORDER[Math.min(index, MENTION_ADD_ORDER.length - 1)] ?? "files";
  const hasActive = show
    ? input.mentionAdd
      ? mentionAddEnabled(activeAdd, input.goalSupport, input.planSupport)
      : index >= 0 && index < search.hits.length
    : false;

  useEffect(() => {
    setHidden(false);
    setIndex(0);
  }, [input.mentionQuery]);

  useEffect(() => {
    const count = input.mentionAdd ? MENTION_ADD_ORDER.length : search.hits.length;
    setIndex((current) => (count === 0 ? 0 : Math.min(current, count - 1)));
  }, [input.mentionAdd, search.hits.length]);

  const write = (next: { text: string; caret: number }) => {
    input.setText(next.text);
    input.setCaret(next.caret);
    placeCaret(input.textareaRef.current, next.caret);
  };

  const insertPaths = (paths: readonly string[]) => {
    write(insertMention(input.text, input.caret, paths));
  };

  const clearToken = () => {
    write(clearAtToken(input.text, input.caret));
  };

  const pickFiles = async () => {
    const started = input.text;
    const cleared = clearAtToken(started, input.caret);
    input.setText(cleared.text);
    input.setCaret(cleared.caret);
    const picked = await pickLocalFiles("选择文件");
    const current = mentionPickText(started, textRef.current, cleared.text);
    // 清掉 @ 之后浏览器可能把光标留在旧下标上。仍用打开文件框前的位置，只夹到当前文本里。
    const caret = caretAfterMentionPick(cleared.caret, null, current.length);
    if (picked.length === 0) {
      placeCaret(input.textareaRef.current, caret);
      return;
    }
    const next = insertMention(current, caret, picked.map((file) => file.path));
    input.setText(next.text);
    input.setCaret(next.caret);
    placeCaret(input.textareaRef.current, next.caret);
  };

  const chooseAdd = (id: MentionAddId) => {
    if (!mentionAddEnabled(id, input.goalSupport, input.planSupport)) return;
    if (id === "files") {
      void pickFiles();
      return;
    }
    clearToken();
    if (id === "goal") input.onGoal();
    else input.onPlan();
  };

  const chooseFile = (file: MentionFile) => {
    insertPaths([file.path]);
  };

  return {
    show,
    index,
    hits: search.hits,
    pending: search.pending,
    error: search.error,
    hasActive,
    dismiss: () => {
      setHidden(true);
      input.textareaRef.current?.focus();
    },
    move: (key: "ArrowDown" | "ArrowUp") => {
      const count = input.mentionAdd ? MENTION_ADD_ORDER.length : search.hits.length;
      setIndex((current) => stepIndex(current, count, key));
    },
    apply: () => {
      if (!hasActive) return;
      if (input.mentionAdd) chooseAdd(activeAdd);
      else {
        const file = search.hits[index];
        if (file) chooseFile(file);
      }
    },
    pick: (target: MentionAddId | MentionFile) => {
      if (typeof target === "string") chooseAdd(target);
      else chooseFile(target);
    },
  };
}
