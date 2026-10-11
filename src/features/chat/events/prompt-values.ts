import type { PromptQuestion } from "../../../types.ts";

export function filledQuestionAnswers(answers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(answers)
      .map(([id, text]) => [id, text.trim()] as const)
      .filter(([, text]) => text.length > 0),
  );
}

export function optionResolvedLabel(
  options: readonly { id: string; label: string }[],
  resolvedAnswer: string | null,
): string | null {
  if (!resolvedAnswer) return null;
  return options.find((option) => option.id === resolvedAnswer)?.label ?? resolvedAnswer;
}

export type ElicitationContent =
  | { ok: true; content: Record<string, string | number | boolean> }
  | { ok: false };

/** 必填项为空时整卡不提交。布尔值始终写入。 */
export function elicitationContent(
  questions: readonly PromptQuestion[],
  values: Record<string, string>,
  flags: Record<string, boolean>,
): ElicitationContent {
  const content: Record<string, string | number | boolean> = {};
  for (const question of questions) {
    if (question.input_kind === "boolean") {
      content[question.id] = Boolean(flags[question.id]);
      continue;
    }
    const raw = (values[question.id] ?? "").trim();
    if (!raw) {
      if (question.required) return { ok: false };
      continue;
    }
    if (question.input_kind === "integer") {
      const parsed = Number.parseInt(raw, 10);
      content[question.id] = Number.isNaN(parsed) ? raw : parsed;
    } else if (question.input_kind === "number") {
      const parsed = Number(raw);
      content[question.id] = Number.isNaN(parsed) ? raw : parsed;
    } else {
      content[question.id] = raw;
    }
  }
  return { ok: true, content };
}
