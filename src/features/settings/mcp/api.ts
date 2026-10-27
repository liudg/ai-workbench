// MCP 管理的 daemon 调用。

import { daemon } from "@/lib/daemon";
import type { AgentKind, McpAddSpec, McpServerRow, McpSurface } from "@/types";

export const mcpSurfaces = () => daemon.call<McpSurface[]>("mcp.surfaces");
export const mcpList = (kind: AgentKind) => daemon.call<McpServerRow[]>("mcp.list", { kind });
export const mcpAdd = (kind: AgentKind, spec: McpAddSpec) => daemon.call<string>("mcp.add", { kind, spec });
export const mcpRemove = (kind: AgentKind, name: string, scope: string) =>
  daemon.call<string>("mcp.remove", { kind, name, scope });
export const mcpLogin = (kind: AgentKind, name: string, registration: string, scopes: string) =>
  daemon.call<string>("mcp.login", { kind, name, registration, scopes });
export const mcpLogout = (kind: AgentKind, name: string) => daemon.call<string>("mcp.logout", { kind, name });
export const mcpSetEnabled = (kind: AgentKind, name: string, enabled: boolean) =>
  daemon.call<string>("mcp.setEnabled", { kind, name, enabled });
export const mcpListTools = (kind: AgentKind, name: string) => daemon.call<string>("mcp.listTools", { kind, name });
