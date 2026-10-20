import { isImeKey } from "../keyboard.ts";

export function stepIndex(current: number, count: number, key: string) {
  if (count === 0) return 0;
  const next = key === "ArrowDown" ? current + 1 : current - 1;
  return (next + count) % count;
}

export type ComposerKeyIntent =
  | { type: "cancel-edit" }
  | { type: "dismiss-mention" }
  | { type: "mention-move"; key: "ArrowDown" | "ArrowUp" }
  | { type: "apply-mention" }
  | { type: "mention-noop" }
  | { type: "skill-move"; key: "ArrowDown" | "ArrowUp" }
  | { type: "apply-skill" }
  | { type: "slash-move"; key: "ArrowDown" | "ArrowUp" }
  | { type: "apply-slash" }
  | { type: "submit" }
  | { type: "submit-now" };

/** Ctrl/Cmd+Enter。Shift 留给换行，Alt 留给别的快捷键。连发不重复送出。 */
export function isSendNowChord(input: {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}): boolean {
  return (
    input.key === "Enter" &&
    !input.shiftKey &&
    !input.altKey &&
    !input.repeat &&
    Boolean(input.ctrlKey || input.metaKey)
  );
}

export function composerKeyIntent(input: {
  key: string;
  shiftKey: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  composing: boolean;
  editing: boolean;
  skillOpen: boolean;
  hasActiveSkill: boolean;
  slashOpen: boolean;
  hasActiveSlash: boolean;
  token: string | null;
  activeSlashName?: string;
  text: string;
  skillQuery: string | null;
  activeSkillMention?: string;
  mentionOpen: boolean;
  hasActiveMention: boolean;
  keyCode?: number;
}): ComposerKeyIntent | null {
  const { key } = input;
  if (isImeKey(input)) return null;
  if (
    key === "Enter" &&
    !input.shiftKey &&
    (input.ctrlKey || input.metaKey) &&
    (input.repeat || input.altKey)
  ) {
    return null;
  }
  if (isSendNowChord(input)) return { type: "submit-now" };
  if (key === "Escape" && input.editing) return { type: "cancel-edit" };
  if (input.mentionOpen && key === "Escape") return { type: "dismiss-mention" };
  if (input.mentionOpen && (key === "ArrowDown" || key === "ArrowUp")) {
    return { type: "mention-move", key };
  }
  if (input.mentionOpen && key === "Tab") {
    return input.hasActiveMention ? { type: "apply-mention" } : { type: "mention-noop" };
  }
  if (input.mentionOpen && key === "Enter" && !input.shiftKey) {
    return input.hasActiveMention ? { type: "apply-mention" } : { type: "mention-noop" };
  }
  if (input.skillOpen && (key === "ArrowDown" || key === "ArrowUp")) {
    return { type: "skill-move", key };
  }
  if (input.skillOpen && key === "Tab" && input.hasActiveSkill) {
    return { type: "apply-skill" };
  }
  if (input.slashOpen && (key === "ArrowDown" || key === "ArrowUp")) {
    return { type: "slash-move", key };
  }
  if (input.slashOpen && key === "Tab" && input.hasActiveSlash) {
    return { type: "apply-slash" };
  }
  if (key === "Enter" && !input.shiftKey) {
    const completingSlash =
      input.slashOpen &&
      input.hasActiveSlash &&
      input.token !== input.activeSlashName &&
      !input.text.trim().includes(" ");
    if (completingSlash) return { type: "apply-slash" };
    const completingSkill =
      input.skillOpen &&
      input.hasActiveSkill &&
      input.skillQuery !== (input.activeSkillMention ?? "").toLowerCase();
    if (completingSkill) return { type: "apply-skill" };
    return { type: "submit" };
  }
  return null;
}
