import { accessModeFromId } from "../../../lib/sandbox.ts";
import {
  emptySandbox,
  type AccessMode,
  type PermissionMenu,
  type PermissionProfileOption,
  type SessionSandbox,
} from "../../../types/index.ts";

// Allow network access
export const NETWORK_LABEL = "允许网络访问";

// --add-dir: Additional directories that should be writable alongside the primary workspace
export const WRITABLE_HEADING = "其他可写目录";
export const WRITABLE_DETAIL = "与主工作区一起可写的其他目录";
export const ADD_DIR_LABEL = "添加目录";

/** 菜单还没给出档位名时，按钮只显示这个入口，不编造档位。 */
export const PERMISSION_BUTTON = "权限";

export { initialSandbox } from "../../../lib/sandbox.ts";

export function selectedPermission(
  menu: PermissionMenu | null,
  sandbox: SessionSandbox | null,
): PermissionProfileOption | undefined {
  if (!menu || !sandbox) return undefined;
  if (sandbox.profileId) return menu.profiles.find((profile) => profile.id === sandbox.profileId);
  return menu.presets.find((preset) => preset.id === sandbox.mode);
}

/** 这一会话还没有本地沙箱时，用菜单报的当前档。对不上就不显示档位。 */
export function sandboxFromMenu(menu: PermissionMenu | null): SessionSandbox | null {
  const id = menu?.active?.trim();
  if (!id || !menu) return null;
  if (menu.profiles.some((profile) => profile.id === id)) {
    return { mode: "ask", networkAccess: false, writableRoots: [], profileId: id };
  }
  const mode = accessModeFromId(id);
  if (mode && menu.presets.some((preset) => preset.id === mode)) return emptySandbox(mode);
  return null;
}

/** 作曲栏按钮上的档位名。只显示菜单里的 label。 */
export function buttonLabel(sandbox: SessionSandbox | null, menu: PermissionMenu | null): string {
  return selectedPermission(menu, sandbox)?.label || PERMISSION_BUTTON;
}

/** 网络开关和额外目录只在当前档声明了 `allows_extras` 时出现。 */
export function extrasAllowed(menu: PermissionMenu | null, sandbox: SessionSandbox | null): boolean {
  return Boolean(selectedPermission(menu, sandbox)?.allows_extras);
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
