import { useCallback, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Plus, SquarePen } from "lucide-react";

import { sessionAgents, unlinkedAgents } from "@/lib/agents";
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
  const installed = sessionAgents(installations);
  const unlinked = unlinkedAgents(installations);
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
    if (installed.length === 1 && unlinked.length === 0) {
      choose(installed[0].kind);
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
          {installations === null ? (
            <div className="px-3 py-3 text-sm text-zinc-500">正在检测本地 Agent…</div>
          ) : installed.length === 0 && unlinked.length === 0 ? (
            <div className="px-3 py-3">
              <p className="text-sm leading-5 text-zinc-300">未检测到已安装的 Agent CLI。</p>
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
            <>
              <div className="px-3 pb-1 pt-1.5 text-[11px] text-zinc-500">选择 Agent</div>
              {installed.map((agent) => (
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
              {unlinked.map((agent) => (
                <div
                  key={agent.kind}
                  role="menuitem"
                  aria-disabled="true"
                  data-agent={agent.kind}
                  className="flex w-full cursor-not-allowed items-baseline justify-between gap-2 px-3 py-2 text-sm text-zinc-500"
                  title="会话协议未接入，不能新建会话"
                >
                  <span>{agent.display_name}</span>
                  <span className="text-[11px]">{agent.version ?? "已安装"} · 未接入</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}
