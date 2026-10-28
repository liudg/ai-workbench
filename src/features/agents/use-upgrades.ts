import { useEffect, useState } from "react";

import { TOPIC_AGENT_UPGRADES, useConnectionStatus, useTopic } from "@/lib/daemon";
import { userFacingMessage } from "@/lib/user-facing";
import type { AgentKind, AgentUpgrade } from "@/types";
import { upgradeAgent } from "./api";

/** 执行状态只读后台快照；请求确认失败不把后台升级改成失败。 */
export function useAgentUpgrades() {
  const upgrades = useTopic<AgentUpgrade[]>(TOPIC_AGENT_UPGRADES);
  const connection = useConnectionStatus();
  const [starting, setStarting] = useState<Partial<Record<AgentKind, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<AgentKind, string>>>({});

  useEffect(() => {
    if (!upgrades) return;
    setErrors((previous) => {
      if (!upgrades.some((entry) => previous[entry.kind])) return previous;
      const next = { ...previous };
      for (const entry of upgrades) delete next[entry.kind];
      return next;
    });
  }, [upgrades]);

  async function upgrade(kind: AgentKind) {
    if (starting[kind] || upgrades?.some((item) => item.kind === kind && item.status === "running")) return;
    setStarting((prev) => ({ ...prev, [kind]: true }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next[kind];
      return next;
    });
    try {
      // 这里只等启动确认，最终结果由订阅给出；不再刷新安装或模型目录。
      await upgradeAgent(kind);
    } catch (error) {
      setErrors((prev) => ({ ...prev, [kind]: userFacingMessage(error) ?? "暂时无法获取更新状态" }));
    } finally {
      setStarting((prev) => ({ ...prev, [kind]: false }));
    }
  }

  return { upgrades, starting, upgradeErrors: errors, upgradesReady: connection === "online" && upgrades !== undefined, upgrade };
}
