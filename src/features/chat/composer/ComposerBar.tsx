import type { RefObject } from "react";
import { ArrowUp, ChevronDown, Plus, Shield } from "lucide-react";

import { cn } from "@/lib/utils";
import type { PermissionProfileOption, SessionSandbox } from "@/types";
import { buttonLabel } from "./access";
import { PlanToggle } from "./PlanToggle";

export function ComposerBar({
  plusRef,
  accessRef,
  modelRef,
  menu,
  imagesOn,
  composerLocked,
  menusLocked,
  sandbox,
  profiles,
  showPlan,
  planOn,
  showModel,
  hasCatalog,
  modelButton,
  editing,
  stopMode,
  sendDisabled,
  onToggleMenu,
  onPickFiles,
  onTogglePlan,
  onCancelEdit,
  onSend,
}: {
  plusRef: RefObject<HTMLButtonElement>;
  accessRef: RefObject<HTMLButtonElement>;
  modelRef: RefObject<HTMLButtonElement>;
  menu: null | "access" | "model" | "attach";
  imagesOn: boolean;
  composerLocked: boolean;
  menusLocked: boolean;
  sandbox: SessionSandbox;
  profiles: PermissionProfileOption[];
  showPlan: boolean;
  planOn: boolean;
  showModel: boolean;
  hasCatalog: boolean;
  modelButton: string;
  editing: boolean;
  stopMode: boolean;
  sendDisabled: boolean;
  onToggleMenu: (name: "access" | "model" | "attach") => void;
  onPickFiles: () => void;
  onTogglePlan: () => void;
  onCancelEdit: () => void;
  onSend: () => void;
}) {
  return (
    <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <button
          ref={plusRef}
          type="button"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="添加附件"
          title="添加附件"
          aria-haspopup={imagesOn ? "menu" : undefined}
          aria-expanded={imagesOn ? menu === "attach" : undefined}
          disabled={composerLocked}
          onClick={(event) => {
            event.stopPropagation();
            if (imagesOn) {
              onToggleMenu("attach");
              return;
            }
            void onPickFiles();
          }}
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          ref={accessRef}
          type="button"
          className={cn(
            "inline-flex h-8 min-w-0 max-w-full items-center gap-1 rounded-full px-2 text-sm hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40",
            sandbox.mode === "full" && !sandbox.profileId ? "text-orange-400" : "text-zinc-300",
          )}
          aria-label="权限"
          aria-haspopup="menu"
          aria-expanded={menu === "access"}
          disabled={composerLocked}
          onClick={(event) => {
            event.stopPropagation();
            onToggleMenu("access");
          }}
        >
          <Shield className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 truncate">{buttonLabel(sandbox, profiles)}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
        </button>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        {showPlan && <PlanToggle pressed={planOn} disabled={menusLocked} onToggle={onTogglePlan} />}
        {showModel && (
          <button
            ref={modelRef}
            type="button"
            className="inline-flex h-8 min-w-0 max-w-52 items-center gap-1 rounded-full px-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="模型"
            aria-haspopup="menu"
            aria-expanded={menu === "model"}
            disabled={composerLocked || !hasCatalog}
            onClick={(event) => {
              event.stopPropagation();
              onToggleMenu("model");
            }}
          >
            <span className="min-w-0 truncate">{modelButton}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
          </button>
        )}
        {editing && (
          <button
            type="button"
            className="h-8 shrink-0 rounded-full px-2 text-sm text-zinc-300 hover:bg-zinc-800"
            onClick={(event) => {
              event.stopPropagation();
              onCancelEdit();
            }}
          >
            取消
          </button>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSend();
          }}
          disabled={sendDisabled}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
          title={stopMode ? "停止" : "发送"}
          aria-label={stopMode ? "停止" : "发送"}
        >
          {stopMode ? <span className="h-2.5 w-2.5 rounded-[2px] bg-current" /> : <ArrowUp className="h-4 w-4" strokeWidth={2.5} />}
        </button>
      </div>
    </div>
  );
}
