// 快捷键冲突检测：平台物理和弦归一化 + `when` 表达式真值表精确可满足性判定。

import { normalizePhysicalChord, detectShortcutPlatform } from "./shortcut.ts";
import type { KeybindingConflict, KeybindingRule, ResolvedKeybindingRule, ShortcutPlatform } from "./types.ts";
import { collectWhenVariables, evaluateWhenAst, parseWhen, type WhenNode } from "./when.ts";

/** 真值表枚举变量数上限（2^14 = 16384 次位运算，远覆盖全部 13 个内置上下文变量）。 */
const MAX_TRUTH_TABLE_VARS = 14;

function isDisabledWhen(when: string | undefined): boolean {
  return when?.trim() === "false";
}

function isConsistentAssignment(assignment: Readonly<Record<string, boolean>>): boolean {
  // isDesktop 与 isWeb 在任意运行环境下严格互补，不能同时成立或同时不成立。
  if ("isDesktop" in assignment && "isWeb" in assignment && assignment.isDesktop === assignment.isWeb) {
    return false;
  }
  // 作曲栏是输入框的子集：composerFocus 为真时 inputFocus 必为真。
  if (assignment.composerFocus === true && assignment.inputFocus === false) {
    return false;
  }
  // 终端拥有隐藏 textarea：terminalFocus 为真时 inputFocus 必为真。
  if (assignment.terminalFocus === true && assignment.inputFocus === false) {
    return false;
  }
  return true;
}

function isConjunctionSatisfiable(astA: WhenNode | null, astB: WhenNode | null): boolean {
  const varsSet = new Set<string>([...collectWhenVariables(astA), ...collectWhenVariables(astB)]);
  const vars = Array.from(varsSet);
  if (vars.length === 0) {
    return evaluateWhenAst(astA, {}) && evaluateWhenAst(astB, {});
  }
  if (vars.length > MAX_TRUTH_TABLE_VARS) {
    return true;
  }
  const total = 1 << vars.length;
  const assignment: Record<string, boolean> = {};
  for (let mask = 0; mask < total; mask += 1) {
    for (let bit = 0; bit < vars.length; bit += 1) {
      assignment[vars[bit]] = (mask & (1 << bit)) !== 0;
    }
    if (!isConsistentAssignment(assignment)) continue;
    if (evaluateWhenAst(astA, assignment) && evaluateWhenAst(astB, assignment)) {
      return true;
    }
  }
  return false;
}

/**
 * 判断两条规则的 `when` 条件是否可能同时成立（即不互斥）。
 * 若任意一方为 `"false"` 或语法非法不可执行，则不会产生运行时冲突。
 */
export function areWhenClausesOverlapping(whenA: string | undefined, whenB: string | undefined): boolean {
  if (isDisabledWhen(whenA) || isDisabledWhen(whenB)) return false;
  const parsedA = parseWhen(whenA);
  const parsedB = parseWhen(whenB);
  if (!parsedA.ok || !parsedB.ok) return false;
  return isConjunctionSatisfiable(parsedA.ast, parsedB.ast);
}

function toResolvedCandidate(rule: KeybindingRule | ResolvedKeybindingRule, fallbackIndex: number): ResolvedKeybindingRule {
  if ("index" in rule && "source" in rule && "parsed" in rule) return rule;
  return {
    index: fallbackIndex,
    command: rule.command,
    key: rule.key,
    when: rule.when,
    source: "user",
    parsed: null,
  };
}

/**
 * 检测规则集中所有实际冲突的快捷键对。
 * 冲突条件：
 * 1. 不同命令（`ruleA.command !== ruleB.command`）；
 * 2. 在当前平台上归一化为相同的物理按键和弦（如 Windows 上 `mod+k` 与 `ctrl+k`）；
 * 3. 均非解绑规则（`key` 非空且 `when !== "false"`）；
 * 4. `when` 子句存在至少一组可同时满足的上下文赋值。
 */
export function detectKeybindingConflicts(
  rules: readonly (KeybindingRule | ResolvedKeybindingRule)[],
  platform: ShortcutPlatform = detectShortcutPlatform(),
): KeybindingConflict[] {
  const byChord = new Map<string, ResolvedKeybindingRule[]>();

  rules.forEach((raw, idx) => {
    if (!raw.command || raw.command.startsWith("-")) return;
    if (!raw.key || !raw.key.trim()) return;
    if (isDisabledWhen(raw.when)) return;
    const shortcut = "parsed" in raw && raw.parsed ? raw.parsed : raw.key;
    const chord = normalizePhysicalChord(shortcut, platform);
    if (!chord) return;
    const candidate = toResolvedCandidate(raw, idx);
    const bucket = byChord.get(chord);
    if (bucket) bucket.push(candidate);
    else byChord.set(chord, [candidate]);
  });

  const conflicts: KeybindingConflict[] = [];
  for (const [chord, group] of byChord) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        const ruleA = group[i];
        const ruleB = group[j];
        if (ruleA.command === ruleB.command) continue;
        if (areWhenClausesOverlapping(ruleA.when, ruleB.when)) {
          conflicts.push({ chord, ruleA, ruleB });
        }
      }
    }
  }
  return conflicts;
}

/** 按命令 ID 聚合与其冲突的其他命令 ID 列表。 */
export function conflictsByCommand(
  conflicts: readonly KeybindingConflict[],
): Map<string, string[]> {
  const map = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    let set = map.get(from);
    if (!set) {
      set = new Set();
      map.set(from, set);
    }
    set.add(to);
  };
  for (const conflict of conflicts) {
    link(conflict.ruleA.command, conflict.ruleB.command);
    link(conflict.ruleB.command, conflict.ruleA.command);
  }
  const out = new Map<string, string[]>();
  for (const [cmd, others] of map) {
    out.set(cmd, Array.from(others));
  }
  return out;
}
