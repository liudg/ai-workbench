import type { RefObject } from "react";
import { Check, Shield } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  ACCESS_LABELS,
  ACCESS_OPTIONS,
  type AccessMode,
  type PermissionProfileOption,
  type SessionSandbox,
} from "@/types";
import {
  ADD_DIR_LABEL,
  CUSTOM_DETAIL,
  CUSTOM_HEADING,
  NETWORK_LABEL,
  PERMISSION_DETAILS,
  PERMISSION_HEADING,
  WRITABLE_DETAIL,
  WRITABLE_HEADING,
} from "./access";

const PRESETS: AccessMode[] = ["ask", "read-only", "approve-for-me", "full"];

export function AccessMenu({
  menuRef,
  sandbox,
  extended,
  approveForMe,
  profiles,
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
  extended: boolean;
  approveForMe: boolean;
  profiles: PermissionProfileOption[];
  showNetwork: boolean;
  showWritable: boolean;
  onPreset: (mode: AccessMode) => void;
  onProfile: (id: string) => void;
  onNetwork: (enabled: boolean) => void;
  onAddDir: () => void;
  onRemoveDir: (path: string) => void;
}) {
  if (!extended) {
    return (
      <div
        ref={menuRef}
        role="menu"
        aria-label="权限"
        className="fixed z-50 w-44 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
        style={{ top: -9999, left: 8 }}
      >
        {ACCESS_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            role="menuitemradio"
            aria-checked={sandbox.mode === option && !sandbox.profileId}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-800",
              option === "full" ? "text-orange-400" : "text-zinc-200",
              sandbox.mode === option && !sandbox.profileId && "bg-zinc-800/70",
            )}
            onClick={() => onPreset(option)}
          >
            <Shield className="h-3.5 w-3.5" />
            {ACCESS_LABELS[option]}
          </button>
        ))}
      </div>
    );
  }

  const presets = PRESETS.filter((mode) => mode !== "approve-for-me" || approveForMe);
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="权限"
      className="fixed z-50 w-80 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
      style={{ top: -9999, left: 8 }}
    >
      <p className="px-3 pb-1 pt-2 text-xs text-zinc-400">{PERMISSION_HEADING}</p>
      {presets.map((mode) => (
        <PresetRow
          key={mode}
          mode={mode}
          checked={!sandbox.profileId && sandbox.mode === mode}
          onPick={() => onPreset(mode)}
        />
      ))}
      {profiles.length > 0 && (
        <>
          <div className="mx-3 my-1 border-t border-zinc-800" />
          <p className="px-3 pb-0.5 pt-1 text-[11px] text-zinc-500">{CUSTOM_HEADING}</p>
          <p className="px-3 pb-1 text-[11px] leading-4 text-zinc-500">{CUSTOM_DETAIL}</p>
          {profiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              role="menuitemradio"
              aria-checked={sandbox.profileId === profile.id}
              className={cn(
                "flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-zinc-800",
                sandbox.profileId === profile.id && "bg-zinc-800/70",
              )}
              onClick={() => onProfile(profile.id)}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-zinc-100">{profile.label}</span>
                {profile.description && (
                  <span className="mt-0.5 block text-xs leading-4 text-zinc-500">
                    {profile.description}
                  </span>
                )}
              </span>
              {sandbox.profileId === profile.id && (
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-200" />
              )}
            </button>
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

function PresetRow({
  mode,
  checked,
  onPick,
}: {
  mode: "ask" | "read-only" | "approve-for-me" | "full";
  checked: boolean;
  onPick: () => void;
}) {
  const warning = mode === "full";
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className={cn(
        "flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-zinc-800",
        checked && "bg-zinc-800/70",
      )}
      onClick={onPick}
    >
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm", warning ? "text-orange-400" : "text-zinc-100")}>
          {ACCESS_LABELS[mode]}
        </span>
        <span className="mt-0.5 block text-xs leading-4 text-zinc-500">
          {PERMISSION_DETAILS[mode]}
        </span>
      </span>
      {checked && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-200" />}
    </button>
  );
}
