import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import type { AgentSkillOption } from "../../../types/index.ts";

/** `$` 菜单没有候选项时的文案。失败不能说成「没有匹配」。 */
export function skillEmptyCopy(input: {
  hasCatalog: boolean;
  skillsError: string | null | undefined;
  listed: number;
}): string {
  if (!input.hasCatalog) return DESKTOP_ZH.skillLoading;
  const error = input.skillsError?.trim();
  if (error && input.listed === 0) return error;
  if (input.listed === 0) return DESKTOP_ZH.skillNone;
  return DESKTOP_ZH.skillNoMatch;
}

/** 光标所在的 `$技能` 片段。返回 `$` 后面的过滤词；刚输入 `$` 时为空字符串。 */
export function skillToken(text: string, caret: number): string | null {
  const upto = text.slice(0, caret);
  const match = upto.match(/(^|[\s\n])\$([A-Za-z0-9_.:-]*)$/);
  return match ? match[2].toLowerCase() : null;
}

export function filterSkills(
  skills: AgentSkillOption[],
  token: string,
): AgentSkillOption[] {
  if (!token) return skills;
  return skills.filter((skill) => {
    const hay = `${skill.mention} ${skill.label} ${skill.name}`.toLowerCase();
    return hay.includes(token);
  });
}

export function insertSkill(
  text: string,
  caret: number,
  mention: string,
): string {
  const upto = text.slice(0, caret);
  const match = upto.match(/(^|[\s\n])\$([A-Za-z0-9_.:-]*)$/);
  const insertion = mention.startsWith("/") || mention.startsWith("$") ? `${mention} ` : `$${mention} `;
  if (!match || match.index == null) return `${text}${insertion}`;
  const start = match.index + match[1].length;
  return text.slice(0, start) + insertion + text.slice(caret);
}
