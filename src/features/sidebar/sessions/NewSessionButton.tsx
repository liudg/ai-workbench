import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { SquarePen } from "lucide-react";

import { immediateSessionAgent, newSessionMenu } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { agentIdentity } from "@/shared/agent/identity";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import type { AgentKind } from "@/types";
import { FixedMenu } from "../FixedMenu";
import { SidebarPlusButton } from "../projects/SidebarPlusButton";
import { useNewSession } from "./use-new-session";

export function NewSessionButton({
  projectId,
  appearance = "pencil",
  className,
  title = "新建会话",
}: {
  projectId: string;
  appearance?: "pencil" | "plus";
  className?: string;
  title?: string;
}) {
  const { openDraft, openSettings, installations, profiles } = useNewSession();
  const menu = newSessionMenu(installations);
  const immediate = immediateSessionAgent(installations);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  const choose = (agent: AgentKind) => {
    setOpen(false);
    openDraft(projectId, agent);
  };

  const onPress = (event: ReactMouseEvent) => {
    event.stopPropagation();
    if (immediate) {
      choose(immediate);
      return;
    }
    setOpen((value) => !value);
  };

  const shown = cn(className, open && "pointer-events-auto opacity-100");
  return (
    <>
      {appearance === "plus" ? (
        <SidebarPlusButton
          buttonRef={anchorRef}
          label={title}
          title={title}
          expanded={open}
          hasPopup
          className={shown}
          onClick={onPress}
        />
      ) : (
        <button
          ref={anchorRef}
          type="button"
          className={shown}
          aria-label={title}
          aria-haspopup="menu"
          aria-expanded={open}
          title={title}
          onClick={onPress}
        >
          <SquarePen className="h-3.5 w-3.5" />
        </button>
      )}
      <FixedMenu
        open={open}
        anchorRef={anchorRef}
        onClose={close}
        label="选择 Agent"
        className="w-60 rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] py-1 shadow-[var(--wb-float-shadow)]"
      >
        {menu.status === "loading" ? (
          <div className="px-3 py-3 text-sm text-[var(--wb-muted)]">正在检测本地 Agent…</div>
        ) : menu.status === "empty" ? (
          <div className="px-3 py-3" data-session-menu="empty" data-session-menu-reason={menu.reason}>
            <p className="text-sm leading-5 text-[var(--wb-text)]">
              {menu.reason === "unwired"
                ? "已安装的 Agent 还不能新建会话。"
                : "未检测到已安装的 Agent CLI。"}
            </p>
            <button
              type="button"
              className="mt-2 text-sm font-medium text-[var(--wb-accent)] hover:underline"
              onClick={(event) => {
                event.stopPropagation();
                close();
                openSettings();
              }}
            >
              打开设置
            </button>
          </div>
        ) : (
          <div data-session-menu="ready">
            <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium text-[var(--wb-muted)]">
              选择 Agent
            </div>
            {menu.agents.map((agent) => (
              <button
                key={agent.kind}
                type="button"
                role="menuitem"
                data-agent={agent.kind}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--wb-text-strong)] transition-colors hover:bg-[var(--wb-hover)] focus-visible:bg-[var(--wb-hover)] focus-visible:outline-none"
                onClick={(event) => {
                  event.stopPropagation();
                  choose(agent.kind);
                }}
              >
                <SessionAgentIcon identity={agentIdentity(agent.kind, profiles[agent.kind])} />
                <span className="truncate">{agent.display_name}</span>
              </button>
            ))}
          </div>
        )}
      </FixedMenu>
    </>
  );
}
