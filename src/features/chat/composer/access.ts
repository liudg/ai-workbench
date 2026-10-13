import {
  ACCESS_LABELS,
  type AccessMode,
  type PermissionMenu,
  type SessionSandbox,
} from "../../../types/index.ts";

// Allow network access
export const NETWORK_LABEL = "允许网络访问";

// --add-dir: Additional directories that should be writable alongside the primary workspace
export const WRITABLE_HEADING = "其他可写目录";
export const WRITABLE_DETAIL = "与主工作区一起可写的其他目录";
export const ADD_DIR_LABEL = "添加目录";

/** 作曲栏按钮上的档位名。菜单读到之前用工作台自己的简称。 */
export function buttonLabel(sandbox: SessionSandbox, menu: PermissionMenu | null): string {
  if (sandbox.profileId) {
    return menu?.profiles.find((profile) => profile.id === sandbox.profileId)?.label ?? sandbox.profileId;
  }
  return menu?.presets.find((preset) => preset.id === sandbox.mode)?.label ?? ACCESS_LABELS[sandbox.mode];
}

/** 网络开关和额外目录只给 ask / 只读 / workspace-write（替我批准）。 */
export function sandboxAllowsExtras(sandbox: SessionSandbox): boolean {
  return !sandbox.profileId && sandbox.mode !== "full";
}

export function selectPreset(current: SessionSandbox, mode: AccessMode): SessionSandbox {
  return { ...current, mode, profileId: "" };
}

export function selectProfile(current: SessionSandbox, profileId: string): SessionSandbox {
  return { ...current, profileId, mode: "ask" };
}

export function setNetwork(current: SessionSandbox, networkAccess: boolean): SessionSandbox {
  return { ...current, networkAccess };
}

export function pathKey(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

export function addWritableRoot(
  current: SessionSandbox,
  path: string,
  cwd = "",
): SessionSandbox {
  const trimmed = path.trim();
  if (!trimmed) return current;
  const key = pathKey(trimmed);
  if (cwd && key === pathKey(cwd)) return current;
  if (current.writableRoots.some((root) => pathKey(root) === key)) return current;
  return { ...current, writableRoots: [...current.writableRoots, trimmed] };
}

export function removeWritableRoot(current: SessionSandbox, path: string): SessionSandbox {
  const key = pathKey(path);
  return {
    ...current,
    writableRoots: current.writableRoots.filter((root) => pathKey(root) !== key),
  };
}
