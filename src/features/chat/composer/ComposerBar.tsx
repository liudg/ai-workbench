import { useRef, type RefObject } from "react";
import { ArrowUp, ChevronDown, Cpu, Lightbulb, Plus, Shield, Target } from "lucide-react";

import { cn } from "@/lib/utils";
import { useElementWidth } from "@/shared/dom/useElementWidth";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { PermissionMenu, SessionSandbox } from "@/types";
import { buttonLabel } from "./access";
import { composerDensity } from "./composer-density";
import { ModeChip } from "./ModeChip";

export function ComposerBar({
  plusRef,
  accessRef,
  modelRef,
  menu,
  imagesOn,
  composerLocked,
  sandbox,
  permissionMenu,
  planChip,
  goalChip,
  showModel,
  hasCatalog,
  modelButton,
  editing,
  stopMode,
  sendDisabled,
  onToggleMenu,
  onPickFiles,
  onDismissPlan,
  onDismissGoal,
  onCancelEdit,
  onSend,
}: {
  plusRef: RefObject<HTMLButtonElement>;
  accessRef: RefObject<HTMLButtonElement>;
  modelRef: RefObject<HTMLButtonElement>;
  menu: null | "access" | "model" | "attach";
  imagesOn: boolean;
  composerLocked: boolean;
  sandbox: SessionSandbox;
  permissionMenu: PermissionMenu | null;
  planChip: boolean;
  goalChip: boolean;
  showModel: boolean;
  hasCatalog: boolean;
  modelButton: string;
  editing: boolean;
  stopMode: boolean;
  sendDisabled: boolean;
  onToggleMenu: (name: "access" | "model" | "attach") => void;
  onPickFiles: () => void;
  onDismissPlan: () => void;
  onDismissGoal: () => void;
  onCancelEdit: () => void;
  onSend: () => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const density = composerDensity(useElementWidth(barRef));
  const icons = density === "icons";
  const accessLabel = buttonLabel(sandbox, permissionMenu);
  return (
    <div
      ref={barRef}
      data-composer-density={density}
      className="mt-1 flex min-w-0 flex-nowrap items-center gap-1"
    >
      <div className="flex min-w-0 flex-1 items-center gap-1">
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
          title={accessLabel}
          className={cn(
            "inline-flex h-8 min-w-0 items-center justify-center gap-1 overflow-hidden rounded-full text-sm hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40",
            icons ? "w-8 shrink-0 px-0" : density === "compact" ? "max-w-[7.5rem] px-2" : "max-w-[11rem] px-2",
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
          {icons ? null : <span className="min-w-0 truncate">{accessLabel}</span>}
          {icons ? null : <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />}
        </button>
        {(planChip || goalChip) && <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-zinc-700" data-mode-divider />}
        {planChip && (
          <ModeChip
            id="plan"
            label={DESKTOP_ZH.planLabel}
            tooltip={DESKTOP_ZH.planTooltip}
            dismissLabel={DESKTOP_ZH.closePlan}
            icon={<Lightbulb className="h-3.5 w-3.5 shrink-0" />}
            iconOnly={icons}
            disabled={composerLocked}
            onDismiss={onDismissPlan}
          />
        )}
        {goalChip && (
          <ModeChip
            id="goal"
            label={DESKTOP_ZH.goalLabel}
            tooltip={DESKTOP_ZH.goalTooltip}
            dismissLabel={DESKTOP_ZH.closeGoal}
            icon={<Target className="h-3.5 w-3.5 shrink-0" />}
            iconOnly={icons}
            disabled={composerLocked}
            onDismiss={onDismissGoal}
          />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {showModel && (
          <button
            ref={modelRef}
            type="button"
            title={modelButton}
            className={cn(
              "inline-flex h-8 min-w-0 items-center justify-center gap-1 overflow-hidden rounded-full text-sm text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40",
              icons ? "w-8 px-0" : density === "compact" ? "max-w-[6.5rem] px-2" : "max-w-52 px-2",
            )}
            aria-label="模型"
            aria-haspopup="menu"
            aria-expanded={menu === "model"}
            disabled={composerLocked || !hasCatalog}
            onClick={(event) => {
              event.stopPropagation();
              onToggleMenu("model");
            }}
          >
            {icons ? <Cpu className="h-3.5 w-3.5 shrink-0" /> : <span className="min-w-0 truncate">{modelButton}</span>}
            {icons ? null : <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />}
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
