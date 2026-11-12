import type { RefObject } from "react";
import { Check } from "lucide-react";

import { SwitchTrack } from "@/components/ui/switch";
import { userFacingMessage } from "@/lib/user-facing";
import { cn } from "@/lib/utils";
import type { PermissionMenu, PermissionProfileOption, SessionSandbox } from "@/types";
import { ADD_DIR_LABEL, NETWORK_LABEL, WRITABLE_HEADING } from "./access";
import { permissionChoiceLabel, permissionMenuTitle, permissionRowDetail } from "./permission-label";

/** 当前会话权限菜单。只显示选项标题，不显示能力说明。 */
export function AccessMenu({
  menuRef,
  sandbox,
  menu,
  showNetwork,
  showWritable,
  onPreset,
  onProfile,
  onNetwork,
  onAddDir,
  onRemoveDir,
}: {
  menuRef: RefObject<HTMLDivElement>;
  sandbox: SessionSandbox | null;
  menu: PermissionMenu | null;
  showNetwork: boolean;
  showWritable: boolean;
  onPreset: (mode: SessionSandbox["mode"]) => void;
  onProfile: (id: string) => void;
  onNetwork: (enabled: boolean) => void;
  onAddDir: () => void;
  onRemoveDir: (path: string) => void;
}) {
  const notice = userFacingMessage(menu?.notice);
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="权限"
      className="wb-popover fixed z-50 w-80 overflow-hidden rounded-xl p-1"
      style={{ top: -9999, left: 8 }}
    >
      {menu === null ? (
        <p className="px-3 py-2 text-sm text-wb-fg-3">正在读取权限…</p>
      ) : (
        <>
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-wb-fg-3">{permissionMenuTitle(menu.title)}</p>
          {notice ? <p className="px-2.5 pb-1 text-xs leading-4 text-wb-fg-3">{notice}</p> : null}
          {menu.presets.map((preset) => (
            <MenuRow
              key={preset.id}
              item={preset}
              warning={Boolean(preset.caution)}
              checked={Boolean(sandbox && !sandbox.profileId && sandbox.mode === preset.id)}
              onPick={() => onPreset(preset.id as SessionSandbox["mode"])}
            />
          ))}
          {menu.profiles.map((profile) => (
            <MenuRow
              key={profile.id}
              item={profile}
              warning={false}
              checked={sandbox?.profileId === profile.id}
              onPick={() => onProfile(profile.id)}
            />
          ))}
        </>
      )}
      {(showNetwork || showWritable) && <div className="mx-2 my-1 border-t border-wb-border" />}
      {showNetwork && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={Boolean(sandbox?.networkAccess)}
          className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-wb-fg transition-colors hover:bg-wb-hover"
          onClick={() => onNetwork(!sandbox?.networkAccess)}
        >
          <span>{NETWORK_LABEL}</span>
          <SwitchTrack checked={Boolean(sandbox?.networkAccess)} size="sm" />
        </button>
      )}
      {showWritable && (
        <div className="px-2.5 py-2">
          <p className="text-sm text-wb-fg">{WRITABLE_HEADING}</p>
          {sandbox && sandbox.writableRoots.length > 0 && (
            <ul className="mt-2 space-y-1">
              {sandbox.writableRoots.map((path) => (
                <li
                  key={path}
                  className="flex min-w-0 items-center gap-2 rounded-lg bg-wb-hover px-2 py-1"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-wb-fg" title={path}>
                    {path}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-wb-fg-2 hover:text-wb-fg"
                    aria-label={`移除 ${path}`}
                    onClick={() => onRemoveDir(path)}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="mt-2 text-sm text-wb-accent hover:underline"
            onClick={onAddDir}
          >
            {ADD_DIR_LABEL}
          </button>
        </div>
      )}
    </div>
  );
}

function MenuRow({
  item,
  warning,
  checked,
  onPick,
}: {
  item: PermissionProfileOption;
  warning: boolean;
  checked: boolean;
  onPick: () => void;
}) {
  const disabled = Boolean(item.disabled_reason);
  const detail = permissionRowDetail(item);
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors",
        disabled ? "cursor-not-allowed opacity-50" : "hover:bg-wb-hover",
        checked && "bg-wb-active/70",
      )}
      onClick={onPick}
    >
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm", warning ? "text-wb-warn" : "text-wb-fg")}>
          {permissionChoiceLabel(item)}
        </span>
        {detail ? <span className="mt-0.5 block truncate text-xs leading-4 text-wb-fg-3">{detail}</span> : null}
      </span>
      {checked && <Check className="h-3.5 w-3.5 shrink-0 text-wb-accent" />}
    </button>
  );
}
