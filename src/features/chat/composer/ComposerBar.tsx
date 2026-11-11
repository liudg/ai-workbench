import { useRef, type RefObject } from "react";
import { ArrowUp, ChevronDown, Plus, Shield, Target } from "lucide-react";

import { cn } from "@/lib/utils";
import { useElementWidth } from "@/shared/dom/useElementWidth";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { PermissionMenu, SessionSandbox } from "@/types";
import { buttonLabel, selectedPermission } from "./access";
import { composerDensity } from "./composer-density";
import { ModeChip } from "./ModeChip";
import { PlanModeIndicator } from "./PlanModeIndicator";

export function ComposerBar({
  plusRef,
  accessRef,
  modelRef,
  menu,
  imagesOn,
  composerLocked,
  sandbox,
  permissionMenu,
  planIndicator,
  goalChip,
  showModel,
  hasCatalog,
  modelButton,
  modelName,
  effortLabel,
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
  sandbox: SessionSandbox | null;
  permissionMenu: PermissionMenu | null;
  /** 当前协作模式是计划，而且这个 Agent 支持计划模式。发消息后仍在。 */
  planIndicator: boolean;
  goalChip: boolean;
  showModel: boolean;
  hasCatalog: boolean;
  modelButton: string;
  /** 选中模型的名字。和强度分开画，避免把强度截成半句。 */
  modelName?: string;
  effortLabel?: string;
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
  const accessCaution = Boolean(selectedPermission(permissionMenu, sandbox)?.caution);
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
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)] disabled:cursor-not-allowed disabled:opacity-40"
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
            "inline-flex h-8 min-w-0 items-center justify-center gap-1 overflow-hidden rounded-full text-sm transition-colors hover:bg-[var(--wb-hover)] disabled:cursor-not-allowed disabled:opacity-40",
            icons ? "w-8 shrink-0 px-0" : density === "compact" ? "max-w-[7.5rem] px-2" : "max-w-[11rem] px-2",
            accessCaution
              ? "text-[var(--wb-warn-strong)]"
              : "text-[var(--wb-muted)] hover:text-[var(--wb-text-strong)]",
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
          <Shield className="h-4 w-4 shrink-0" />
          {icons ? null : <span className="min-w-0 truncate">{accessLabel}</span>}
          {icons ? null : <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />}
        </button>
        {(planIndicator || goalChip) && (
          <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-[var(--wb-border-strong)]" data-mode-divider />
        )}
        {planIndicator && <PlanModeIndicator disabled={composerLocked} onExit={onDismissPlan} />}
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
              "inline-flex h-8 min-w-0 items-center justify-center gap-1 overflow-hidden rounded-full px-2 text-sm text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)] disabled:cursor-not-allowed disabled:opacity-40",
              icons || density === "compact" ? "max-w-[8.5rem]" : "max-w-52",
            )}
            data-model-chip
            aria-label="模型"
            aria-haspopup="menu"
            aria-expanded={menu === "model"}
            disabled={composerLocked || !hasCatalog}
            onClick={(event) => {
              event.stopPropagation();
              onToggleMenu("model");
            }}
          >
            {modelName ? (
              <span className="inline-flex min-w-0 items-center gap-1">
                <span className="min-w-0 truncate">{modelName}</span>
                {effortLabel ? (
                  <span data-model-effort className="shrink-0 whitespace-nowrap">
                    {effortLabel}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="min-w-0 truncate">{modelButton}</span>
            )}
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
          </button>
        )}
        {editing && (
          <button
            type="button"
            className="h-8 shrink-0 rounded-full px-2 text-sm text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]"
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
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--wb-send-bg)] text-[var(--wb-send-fg)] shadow-xs transition-all hover:opacity-90 disabled:cursor-not-allowed disabled:bg-[var(--wb-send-disabled-bg)] disabled:text-[var(--wb-send-disabled-fg)] disabled:shadow-none"
          title={stopMode ? "停止" : "发送"}
          aria-label={stopMode ? "停止" : "发送"}
        >
          {stopMode ? <span className="h-2.5 w-2.5 rounded-[2px] bg-current" /> : <ArrowUp className="h-4 w-4" strokeWidth={2.5} />}
        </button>
      </div>
    </div>
  );
}
