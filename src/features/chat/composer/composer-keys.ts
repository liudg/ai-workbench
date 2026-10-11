export function stepIndex(current: number, count: number, key: string) {
  if (count === 0) return 0;
  const next = key === "ArrowDown" ? current + 1 : current - 1;
  return (next + count) % count;
}

export type ComposerKeyIntent =
  | { type: "cancel-edit" }
  | { type: "skill-move"; key: "ArrowDown" | "ArrowUp" }
  | { type: "apply-skill" }
  | { type: "slash-move"; key: "ArrowDown" | "ArrowUp" }
  | { type: "apply-slash" }
  | { type: "submit" };

export function composerKeyIntent(input: {
  key: string;
  shiftKey: boolean;
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
}): ComposerKeyIntent | null {
  const { key } = input;
  if (key === "Escape" && input.editing) return { type: "cancel-edit" };
  if (input.skillOpen && (key === "ArrowDown" || key === "ArrowUp")) {
    return { type: "skill-move", key };
  }
  if (input.skillOpen && key === "Tab" && input.hasActiveSkill && !input.composing) {
    return { type: "apply-skill" };
  }
  if (input.slashOpen && (key === "ArrowDown" || key === "ArrowUp")) {
    return { type: "slash-move", key };
  }
  if (input.slashOpen && key === "Tab" && input.hasActiveSlash && !input.composing) {
    return { type: "apply-slash" };
  }
  if (key === "Enter" && !input.shiftKey && !input.composing) {
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
