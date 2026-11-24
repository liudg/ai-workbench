// 本机 `aiwb` 命令行工具查询、安装与卸载（仅桌面端可用）。

import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "@/lib/daemon/endpoint";

export interface CliCommandStatus {
  supported: boolean;
  installed: boolean;
  shimPath: string | null;
  onPath: boolean;
}

const UNSUPPORTED_STATUS: CliCommandStatus = {
  supported: false,
  installed: false,
  shimPath: null,
  onPath: false,
};

const DESKTOP_ONLY = "只能在桌面版里安装命令行工具";

export async function getCliCommandStatus(): Promise<CliCommandStatus> {
  if (!isTauri) return UNSUPPORTED_STATUS;
  return invoke<CliCommandStatus>("cli_command_status");
}

export async function installCliCommand(): Promise<CliCommandStatus> {
  if (!isTauri) throw new Error(DESKTOP_ONLY);
  return invoke<CliCommandStatus>("install_cli_command");
}

export async function uninstallCliCommand(): Promise<CliCommandStatus> {
  if (!isTauri) throw new Error(DESKTOP_ONLY);
  return invoke<CliCommandStatus>("uninstall_cli_command");
}
