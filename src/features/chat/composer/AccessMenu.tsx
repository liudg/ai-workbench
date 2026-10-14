import type { RefObject } from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import type { PermissionMenu, PermissionProfileOption, SessionSandbox } from "@/types";
import { ADD_DIR_LABEL, NETWORK_LABEL, WRITABLE_DETAIL, WRITABLE_HEADING } from "./access";

/**
 * 作曲栏权限菜单。标题、档位和配置档的文案都由适配器给出
 * （Codex 取自 TUI `/permissions` 与 `permissionProfile/list`）；网络和额外目录是工作台扩展。
 */
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
  sandbox: SessionSandbox;
  menu: PermissionMenu | null;
  showNetwork: boolean;
  showWritable: boolean;
  onPreset: (mode: SessionSandbox["mode"]) => void;
  onProfile: (id: string) => void;
  onNetwork: (enabled: boolean) => void;
  onAddDir: () => void;
  onRemoveDir: (path: string) => void;
}) {
  const notice = menu?.notice?.trim() || null;
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="权限"
      className="fixed z-50 w-80 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
      style={{ top: -9999, left: 8 }}
    >
      {menu === null ? (
        <p className="px-3 py-2 text-sm text-zinc-500">正在读取权限…</p>
      ) : (
        <>
          <p className="px-3 pb-1 pt-2 text-xs font-medium text-zinc-300">{menu.title}</p>
          {notice ? <p className="px-3 pb-1 text-xs leading-4 text-zinc-500">{notice}</p> : null}
          {menu.presets.map((preset) => (
            <MenuRow
              key={preset.id}
              item={preset}
              warning={preset.id === "full"}
              checked={!sandbox.profileId && sandbox.mode === preset.id}
              onPick={() => onPreset(preset.id as SessionSandbox["mode"])}
            />
          ))}
          {menu.profiles.map((profile) => (
            <MenuRow
              key={profile.id}
              item={profile}
              warning={false}
              checked={sandbox.profileId === profile.id}
              onPick={() => onProfile(profile.id)}
            />
          ))}
        </>
      )}
      {(showNetwork || showWritable) && <div className="mx-3 my-1 border-t border-zinc-800" />}
      {showNetwork && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={sandbox.networkAccess}
          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800"
          onClick={() => onNetwork(!sandbox.networkAccess)}
        >
          <span>{NETWORK_LABEL}</span>
          <span
            className={cn(
              "relative h-4 w-7 shrink-0 rounded-full transition-colors",
              sandbox.networkAccess ? "bg-zinc-100" : "bg-zinc-700",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-3 w-3 rounded-full transition-transform",
                sandbox.networkAccess ? "translate-x-3.5 bg-zinc-900" : "translate-x-0.5 bg-zinc-300",
              )}
            />
          </span>
        </button>
      )}
      {showWritable && (
        <div className="px-3 py-2">
          <p className="text-sm text-zinc-100">{WRITABLE_HEADING}</p>
          <p className="mt-0.5 text-xs leading-4 text-zinc-500">{WRITABLE_DETAIL}</p>
          {sandbox.writableRoots.length > 0 && (
            <ul className="mt-2 space-y-1">
              {sandbox.writableRoots.map((path) => (
                <li
                  key={path}
                  className="flex min-w-0 items-center gap-2 rounded-md bg-zinc-800/80 px-2 py-1"
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-200" title={path}>
                    {path}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-zinc-400 hover:text-zinc-100"
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
            className="mt-2 text-sm text-zinc-200 hover:text-white"
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
  const detail = item.disabled_reason ?? item.description;
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left",
        disabled ? "cursor-not-allowed opacity-50" : "hover:bg-zinc-800",
        checked && "bg-zinc-800/70",
      )}
      onClick={onPick}
    >
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm", warning ? "text-orange-400" : "text-zinc-100")}>
          {item.label}
        </span>
        {detail ? <span className="mt-0.5 block truncate text-xs leading-4 text-zinc-500">{detail}</span> : null}
      </span>
      {checked && <Check className="h-3.5 w-3.5 shrink-0 text-zinc-200" />}
    </button>
  );
}
