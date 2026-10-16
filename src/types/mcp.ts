// 与 `src-tauri/src/models/mcp.rs` 对应。界面只读这些字段。

import type { AgentKind } from "./agent";

export interface McpLabeled {
  id: string;
  label: string;
}

export interface McpField {
  id: string;
  label: string;
  placeholder: string;
  /** `always`、`stdio`、`http`、`sse` 或 `http-sse`。 */
  when: string;
}

export interface McpVerbs {
  list: boolean;
  add: boolean;
  remove: boolean;
  login: boolean;
  logout: boolean;
  enable: boolean;
  disable: boolean;
  list_tools: boolean;
}

export interface McpNote {
  label: string;
  reason: string;
}

export interface McpSurface {
  kind: AgentKind;
  display_name: string;
  installed: boolean;
  manageable: boolean;
  unavailable_reason?: string | null;
  verbs: McpVerbs;
  transports: McpLabeled[];
  scopes: McpLabeled[];
  fields: McpField[];
  oauth_registration: McpLabeled[];
  /** `status`、`http`、`always` 或 `never`。 */
  login_rule: string;
  login_statuses: string[];
  logout_label: string;
  scope_label: string;
  tools_label: string;
  notes: McpNote[];
}

export interface McpPair {
  key: string;
  value: string;
}

export interface McpAddSpec {
  name: string;
  transport: string;
  command: string;
  args: string[];
  env: McpPair[];
  url: string;
  bearer_token_env_var: string;
  headers: McpPair[];
  scope: string;
  client_id: string;
  client_secret: string;
  oauth_resource: string;
  callback_port: string;
  oauth_registration: string;
}

export interface McpServerRow {
  name: string;
  transport: string;
  command: string;
  args: string[];
  url: string;
  bearer_token_env_var: string;
  enabled: boolean | null;
  auth_status: string;
  status_text: string;
  scope: string;
  cwd: string;
  env: McpPair[];
  env_vars: string[];
  headers: McpPair[];
  env_headers: McpPair[];
}
