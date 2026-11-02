/** 会话行菜单。改名、置顶、归档、删除都记在工作台的数据库里，所有 Agent 都有；分叉看 Agent 能不能分。 */

import type { ForkTarget } from "../../tasks/fork-targets.ts";
import type { AgentKind } from "../../../types/index.ts";

export type SessionMenuAction = "rename" | "pin" | "fork" | "archive" | "delete";

export interface SessionMenuItem {
  key: string;
  id: SessionMenuAction;
  label: string;
  /** 分叉到哪个 Agent。 */
  agent?: AgentKind;
  danger?: boolean;
}

export function sessionMenuItems(input: {
  pinned: boolean;
  archived: boolean;
  forks: readonly ForkTarget[];
}): SessionMenuItem[] {
  return [
    { key: "rename", id: "rename", label: "重命名" },
    { key: "pin", id: "pin", label: input.pinned ? "取消置顶" : "置顶" },
    ...input.forks.map((target) => ({
      key: `fork:${target.agent}`,
      id: "fork" as const,
      label: target.same ? "分叉" : `分叉到 ${target.name}`,
      agent: target.agent,
    })),
    { key: "archive", id: "archive", label: input.archived ? "取消归档" : "归档" },
    { key: "delete", id: "delete", label: "删除", danger: true },
  ];
}
