import {
  ACCESS_LABELS,
  emptySandbox,
  type AccessMode,
  type PermissionProfileOption,
  type SessionSandbox,
} from "../../../types.ts";

/**
 * 官方 Codex 桌面端作曲栏权限菜单文案。
 * 英文原文来自 ChatGPT desktop「How should ChatGPT actions be approved?」。
 */
export const PERMISSION_HEADING = "操作应如何获得批准？";

export const PERMISSION_DETAILS: Record<
  "ask" | "read-only" | "approve-for-me" | "full",
  string
> = {
  // Always ask to edit external files and use the internet
  ask: "编辑工作区外的文件或使用互联网时始终询问",
  // read-only sandbox: inspect files; edits and writes need approval
  "read-only": "可以阅读文件。编辑或运行会写入的命令前需要批准",
  // Only ask for actions detected as potentially unsafe
  "approve-for-me": "仅询问被判定为可能不安全的操作",
  // Unrestricted access to the internet and any file on your computer
  full: "可不受限制地访问互联网和计算机上的任何文件",
};

// Custom (config.toml) / Uses permissions defined in config.toml
export const CUSTOM_HEADING = "自定义 (config.toml)";
export const CUSTOM_DETAIL = "使用 config.toml 中定义的权限";

// Allow network access
export const NETWORK_LABEL = "允许网络访问";

// --add-dir: Additional directories that should be writable alongside the primary workspace
export const WRITABLE_HEADING = "其他可写目录";
export const WRITABLE_DETAIL = "与主工作区一起可写的其他目录";
export const ADD_DIR_LABEL = "添加目录";

/** 没有沙箱扩展能力的 agent 只保留完全访问 / 询问批准 / 只读。 */
export function sandboxForAgent(
  sandbox: SessionSandbox,
  caps?: {
    supports_network_access?: boolean;
    supports_writable_roots?: boolean;
    supports_permission_profiles?: boolean;
    supports_approve_for_me?: boolean;
  },
): SessionSandbox {
  const extended = Boolean(
    caps?.supports_network_access ||
      caps?.supports_writable_roots ||
      caps?.supports_permission_profiles ||
      caps?.supports_approve_for_me,
  );
  if (extended) return sandbox;
  const mode: AccessMode =
    sandbox.mode === "full" || sandbox.mode === "ask" || sandbox.mode === "read-only"
      ? sandbox.mode
      : "ask";
  return emptySandbox(mode);
}

export function buttonLabel(
  sandbox: SessionSandbox,
  profiles: PermissionProfileOption[] = [],
): string {
  if (sandbox.profileId) {
    return (
      profiles.find((profile) => profile.id === sandbox.profileId)?.label ??
      sandbox.profileId
    );
  }
  return ACCESS_LABELS[sandbox.mode];
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
