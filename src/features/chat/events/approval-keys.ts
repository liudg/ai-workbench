import { isImeKey } from "../keyboard.ts";

export type ApprovalKeyAction = "approve" | "deny" | "none";

export interface ApprovalGate {
  busy: boolean;
}

/**
 * Esc 拒绝，Enter 同意。
 * 输入框里的 Enter 留给发送。别的界面已经接住的 Esc，不再拿来拒绝。
 * 组字期间整键都留给输入法。
 */
export function approvalKeyAction(input: {
  key: string;
  composing?: boolean;
  keyCode?: number;
  defaultPrevented: boolean;
  inDialog: boolean;
  onButton: boolean;
  inField: boolean;
}): ApprovalKeyAction {
  if (isImeKey(input) || input.defaultPrevented || input.inDialog) return "none";
  if (input.key === "Escape") return "deny";
  if (input.key !== "Enter" || input.onButton || input.inField) return "none";
  return "approve";
}

/** 同一次审批只能送出一回。失败后放开，方便再点。 */
export function takeApproval(gate: ApprovalGate): boolean {
  if (gate.busy) return false;
  gate.busy = true;
  return true;
}

export function releaseApproval(gate: ApprovalGate) {
  gate.busy = false;
}

/** 失败时只放开这一次占用。已经换成下一问时，不能把新的占用清掉。 */
export function releaseOwnedApproval(current: ApprovalGate, owned: ApprovalGate): boolean {
  if (current !== owned) return false;
  owned.busy = false;
  return true;
}
