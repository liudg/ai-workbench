import {
  emptySandbox,
  type AccessMode,
  type AgentInstallation,
  type AgentKind,
  type SessionSandbox,
} from "../types/index.ts";

/** 没有沙箱扩展能力的 agent 只保留完全访问 / 询问批准 / 只读。 */
export function sandboxForAgent(
  sandbox: SessionSandbox,
  caps?: {
    supports_network_access?: boolean;
    supports_writable_roots?: boolean;
    supports_permission_profiles?: boolean;
    supports_approve_for_me?: boolean;
  },
): SessionSandbox {
  const extended = Boolean(
    caps?.supports_network_access ||
      caps?.supports_writable_roots ||
      caps?.supports_permission_profiles ||
      caps?.supports_approve_for_me,
  );
  if (extended) return sandbox;
  const mode: AccessMode =
    sandbox.mode === "full" || sandbox.mode === "ask" || sandbox.mode === "read-only"
      ? sandbox.mode
      : "ask";
  return emptySandbox(mode);
}

/** 本机探测到已安装的 Agent。探测为空或都未安装时返回空数组，不补种类默认值。 */
export function installedAgents(
  list: AgentInstallation[] | null | undefined,
): AgentInstallation[] {
  if (!list?.length) return [];
  return list.filter((item) => item.installed === true);
}

/**
 * 能开会话的 Agent：已安装，并且会话协议已接入（`session_linked`）。
 * 新建会话、项目默认 Agent 都只从这里取。
 */
export function sessionAgents(
  list: AgentInstallation[] | null | undefined,
): AgentInstallation[] {
  return installedAgents(list).filter((item) => item.session_linked === true);
}

/** 已安装但会话协议未接入的 Agent。设置页显示「未接入」；新建会话菜单不列出它们。 */
export function unlinkedAgents(
  list: AgentInstallation[] | null | undefined,
): AgentInstallation[] {
  return installedAgents(list).filter((item) => item.session_linked !== true);
}

export type SessionMenu =
  | { status: "loading" }
  | { status: "empty"; reason: "none" | "unwired" }
  | { status: "ready"; agents: AgentInstallation[] };

/** 新建会话菜单。只包含能开会话的 Agent，不给未接入的留灰色占位。 */
export function newSessionMenu(list: AgentInstallation[] | null | undefined): SessionMenu {
  if (list == null) return { status: "loading" };
  const agents = sessionAgents(list);
  if (agents.length > 0) return { status: "ready", agents };
  if (unlinkedAgents(list).length > 0) return { status: "empty", reason: "unwired" };
  return { status: "empty", reason: "none" };
}

/**
 * 项目行上的新建按钮：只有一个能开会话的 Agent 时直接用它。
 * 主按钮始终打开菜单，方便确认当前接的是谁。
 */
export function immediateSessionAgent(
  list: AgentInstallation[] | null | undefined,
): AgentKind | null {
  if (!list) return null;
  const usable = sessionAgents(list);
  if (usable.length !== 1) return null;
  return usable[0].kind;
}

/**
 * 写进项目记录的默认 Agent。只用能开会话、且用户最近选过的；
 * 否则用第一个能开会话的。一个都没有时返回 null，不拿注册表第一项充数。
 */
export function persistedAgentKind(
  list: AgentInstallation[] | null | undefined,
  preferred: AgentKind | null,
): AgentKind | null {
  const usable = sessionAgents(list);
  if (preferred && usable.some((item) => item.kind === preferred)) {
    return preferred;
  }
  return usable[0]?.kind ?? null;
}

export function keepPreferredAgent(
  current: AgentKind | null,
  list: AgentInstallation[],
): AgentKind | null {
  const usable = sessionAgents(list);
  if (current && usable.some((item) => item.kind === current)) return current;
  if (usable.length === 1) return usable[0].kind;
  return null;
}
