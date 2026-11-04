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
  /** 有就是二级菜单：选里面的一项才执行。 */
  children?: SessionMenuItem[];
}

export function sessionMenuItems(input: {
  pinned: boolean;
  archived: boolean;
  forks: readonly ForkTarget[];
}): SessionMenuItem[] {
  return [
    { key: "rename", id: "rename", label: "重命名" },
    { key: "pin", id: "pin", label: input.pinned ? "取消置顶" : "置顶" },
    ...forkItems(input.forks),
    { key: "archive", id: "archive", label: input.archived ? "取消归档" : "归档" },
    { key: "delete", id: "delete", label: "删除", danger: true },
  ];
}

/** 只能分给一个 Agent 时直接点；能分给几个时收进「分叉」的二级菜单，按 Agent 名字列出。 */
function forkItems(forks: readonly ForkTarget[]): SessionMenuItem[] {
  const [only] = forks;
  if (!only) return [];
  if (forks.length === 1) {
    const label = only.same ? "分叉" : `分叉到 ${only.name}`;
    return [{ key: `fork:${only.agent}`, id: "fork", label, agent: only.agent }];
  }
  return [
    {
      key: "fork",
      id: "fork",
      label: "分叉",
      children: forks.map((target) => ({
        key: `fork:${target.agent}`,
        id: "fork" as const,
        label: target.same ? `${target.name}（当前）` : target.name,
        agent: target.agent,
      })),
    },
  ];
}
