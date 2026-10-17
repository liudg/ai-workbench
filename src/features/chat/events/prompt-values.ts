import type { PromptQuestion, SessionStatus } from "../../../types/index.ts";

/**
 * 提问卡能不能操作只看它有没有被回答、会话是否还活着。
 * 运行状态来自 Codex `thread/status/changed`，工作台自己的选择卡不改它。
 */
export function promptInteractive(resolvedAnswer: string | null, status: SessionStatus): boolean {
  return resolvedAnswer === null && status !== "stopped" && status !== "failed";
}

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

/** 卡片正文。去掉首尾空行，中间换行留着。 */
export function compactBlock(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/** 「已回答：答案」。空回答和纯空行都不占一行。 */
export function settledAnswerLine(answer: string | null): string | null {
  if (!answer) return null;
  const text = compactBlock(answer);
  return text ? `已回答：${text}` : null;
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
