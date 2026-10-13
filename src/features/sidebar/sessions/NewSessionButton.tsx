import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Plus, SquarePen } from "lucide-react";

import { immediateSessionAgent, newSessionMenu } from "@/lib/agents";
import { cn } from "@/lib/utils";
import { useWorkbench } from "@/store";
import type { AgentKind } from "@/types";
import { buttonVariants } from "@/components/ui/button";
import { useFixedMenu } from "../use-fixed-menu";

export function NewSessionButton({
  projectId,
  appearance = "pencil",
  className,
  title = "新建会话",
}: {
  projectId: string;
  appearance?: "pencil" | "primary";
  className?: string;
  title?: string;
}) {
  const createSession = useWorkbench((s) => s.createSession);
  const openSettings = useWorkbench((s) => s.openSettings);
  const installations = useWorkbench((s) => s.installations);
  const menu = newSessionMenu(installations);
  const immediate = appearance === "primary" ? null : immediateSessionAgent(installations);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useFixedMenu(open, anchorRef, menuRef, close, "below");

  const choose = (agent: AgentKind) => {
    setOpen(false);
    void createSession(projectId, agent);
  };

  const onPress = (event: ReactMouseEvent) => {
    event.stopPropagation();
    if (immediate) {
      choose(immediate);
      return;
    }
    setOpen((value) => !value);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={cn(
          appearance === "primary" && buttonVariants({ variant: "default" }),
          className,
          open && "pointer-events-auto opacity-100",
        )}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={onPress}
      >
        {appearance === "primary" ? (
          <>
            <Plus /> 新建会话
          </>
        ) : (
          <SquarePen className="h-3.5 w-3.5" />
        )}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="选择 Agent"
          className="fixed z-50 w-60 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
          style={{ top: -9999, left: 8 }}
        >
          {menu.status === "loading" ? (
            <div className="px-3 py-3 text-sm text-zinc-500">正在检测本地 Agent…</div>
          ) : menu.status === "empty" ? (
            <div className="px-3 py-3" data-session-menu="empty" data-session-menu-reason={menu.reason}>
              <p className="text-sm leading-5 text-zinc-300">
                {menu.reason === "unwired"
                  ? "已安装的 Agent 还不能新建会话。"
                  : "未检测到已安装的 Agent CLI。"}
              </p>
              <button
                type="button"
                className="mt-2 text-sm text-indigo-300 hover:text-indigo-200"
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
              <div className="px-3 pb-1 pt-1.5 text-[11px] text-zinc-500">选择 Agent</div>
              {menu.agents.map((agent) => (
                <button
                  key={agent.kind}
                  type="button"
                  role="menuitem"
                  data-agent={agent.kind}
                  className="block w-full px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800"
                  onClick={(event) => {
                    event.stopPropagation();
                    choose(agent.kind);
                  }}
                >
                  {agent.display_name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
