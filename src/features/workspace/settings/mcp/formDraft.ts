import type { McpAddSpec, McpField, McpPair, McpSurface } from "@/types";

import { defaultScope, defaultTransport, showRegistration, visibleFields } from "./view.ts";

/** 添加表单文案。协议名保持英文。 */
export const FORM_TEXT = {
  pasteConfig: "粘贴配置",
  pastePairs: "每行一个键值，可一次粘贴多行。",
  pasteList: "每行一个参数，可一次粘贴多行。",
  copyEntry: "复制",
  copied: "已复制",
  copyFailed: "无法复制。",
  pasteFailed: "无法读取剪贴板。",
  pasteUnrecognized: "无法识别这段配置。",
  pasteMany: "一次只能粘贴一个服务器。",
  duplicateName: "已有同名服务器。",
  nameInvalid: "名称不能为空，也不能含空白。",
  urlScheme: "URL 需要以 http:// 或 https:// 开头。",
  urlSpace: "URL 不能含空白。",
  portInvalid: "回调端口必须是正整数。",
  commandNewline: "启动命令不能换行。",
  argNewline: "参数不能换行。",
  envValueNewline: "环境变量值不能换行。",
  headerValueNewline: "请求头的值不能换行。",
  emptyKey: "请填写键。",
  showSecret: "显示",
  hideSecret: "隐藏",
};

export interface McpFormDraft {
  transport: string;
  scope: string;
  registration: string;
  values: Record<string, string>;
  lists: Record<string, string[]>;
  pairs: Record<string, McpPair[]>;
}

export interface ParsedServer {
  name?: string;
  transport?: string;
  command?: string;
  args?: string[];
  env?: McpPair[];
  url?: string;
  headers?: McpPair[];
  bearer?: string;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
  oauthResource?: string;
  callbackPort?: string;
}

export type PasteRead = { ok: true; server: ParsedServer } | { ok: false; error: string };

export interface FormCheck {
  errors: Record<string, string>;
  focusId: string | null;
}

const SPEC_IDS = new Set([
  "name",
  "command",
  "args",
  "env",
  "url",
  "bearer_token_env_var",
  "headers",
  "client_id",
  "client_secret",
  "oauth_resource",
  "callback_port",
]);

export function knownSpecId(id: string): boolean {
  return SPEC_IDS.has(id);
}

export function createDraft(surface: McpSurface): McpFormDraft {
  return {
    transport: defaultTransport(surface),
    scope: defaultScope(surface),
    registration: surface.oauth_registration[0]?.id ?? "",
    values: {},
    lists: {},
    pairs: {},
  };
}

export function requiredMessage(label: string): string {
  const gap = /^[A-Za-z]/.test(label) ? " " : "";
  return `请填写${gap}${label}。`;
}

export function ignoredPasteMessage(labels: string[]): string {
  return `已忽略 ${labels.join("、")}，当前配置没有这一项。`;
}

export function invalidEnvName(key: string): string {
  return key ? `环境变量名无效：${key}` : FORM_TEXT.emptyKey;
}

export function invalidHeaderName(key: string): string {
  return key ? `请求头名无效：${key}` : FORM_TEXT.emptyKey;
}

export function duplicateEnvName(key: string): string {
  return `环境变量名重复：${key}`;
}

export function duplicateHeaderName(key: string): string {
  return `请求头名重复：${key}`;
}

export function newlineMessage(label: string): string {
  return `${label}不能换行。`;
}

export function validateDraft(surface: McpSurface, draft: McpFormDraft, existingNames: readonly string[]): FormCheck {
  const errors: Record<string, string> = {};
  let focusId: string | null = null;
  for (const field of visibleFields(surface.fields, draft.transport)) {
    const message = validateField(field, draft, existingNames);
    if (!message) continue;
    errors[field.id] = message;
    focusId ??= field.id;
  }
  return { errors, focusId };
}

export function draftToSpec(surface: McpSurface, draft: McpFormDraft): McpAddSpec {
  const fields = visibleFields(surface.fields, draft.transport);
  const ids = new Set(fields.map((field) => field.id));
  const text = (id: string) => (ids.has(id) ? (draft.values[id] ?? "").trim() : "");
  const list = (id: string) =>
    ids.has(id) ? (draft.lists[id] ?? []).filter((item) => item.trim()) : [];
  const pairs = (id: string) => (ids.has(id) ? filledPairs(draft.pairs[id] ?? []) : []);
  return {
    name: text("name"),
    transport: draft.transport,
    command: text("command"),
    args: list("args"),
    env: pairs("env"),
    url: text("url"),
    bearer_token_env_var: text("bearer_token_env_var"),
    headers: pairs("headers"),
    scope: surface.scopes.length > 0 ? draft.scope : "",
    client_id: text("client_id"),
    client_secret: text("client_secret"),
    oauth_resource: text("oauth_resource"),
    callback_port: text("callback_port"),
    oauth_registration: showRegistration(surface, draft.transport) ? draft.registration : "",
  };
}

export function parsePairPaste(text: string): McpPair[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return pairsFromJson(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return pairsFromLines(trimmed);
}

export function parseListPaste(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[")) {
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
    } catch {
      return null;
    }
    return null;
  }
  if (!trimmed.includes("\n")) return null;
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : null;
}

export function readServerPaste(text: string): PasteRead {
  const stripped = stripFence(text);
  if (!stripped) return { ok: false, error: FORM_TEXT.pasteUnrecognized };
  let value: unknown;
  try {
    value = JSON.parse(stripped);
  } catch {
    return { ok: false, error: FORM_TEXT.pasteUnrecognized };
  }
  const root = asRecord(value);
  if (!root) return { ok: false, error: FORM_TEXT.pasteUnrecognized };
  const wrapped = asRecord(root.mcpServers) ?? asRecord(root.mcp_servers);
  if (wrapped) {
    const keys = Object.keys(wrapped);
    if (keys.length === 0) return { ok: false, error: FORM_TEXT.pasteUnrecognized };
    if (keys.length > 1) return { ok: false, error: FORM_TEXT.pasteMany };
    const body = asRecord(wrapped[keys[0]]);
    if (!body || !looksLikeServer(body)) return { ok: false, error: FORM_TEXT.pasteUnrecognized };
    const server = serverFrom(body, keys[0]);
    return server ? { ok: true, server } : { ok: false, error: FORM_TEXT.pasteUnrecognized };
  }
  if (!looksLikeServer(root)) return { ok: false, error: FORM_TEXT.pasteUnrecognized };
  const server = serverFrom(root);
  return server ? { ok: true, server } : { ok: false, error: FORM_TEXT.pasteUnrecognized };
}

export function applyServerPaste(
  surface: McpSurface,
  draft: McpFormDraft,
  server: ParsedServer,
): { draft: McpFormDraft; notice: string | null } | { error: string } {
  const known = new Set(surface.fields.map((field) => field.id));
  const next: McpFormDraft = {
    ...draft,
    values: { ...draft.values },
    lists: { ...draft.lists },
    pairs: { ...draft.pairs },
  };
  let applied = false;
  const transport = matchTransport(surface, server);
  if (transport && transport !== draft.transport) {
    next.transport = transport;
    applied = true;
  }
  const putText = (id: string, value: string | undefined) => {
    if (value == null || !known.has(id)) return;
    next.values[id] = value;
    applied = true;
  };
  putText("name", server.name);
  putText("command", server.command);
  putText("url", server.url);
  putText("bearer_token_env_var", server.bearer);
  putText("client_id", server.clientId);
  putText("client_secret", server.clientSecret);
  putText("oauth_resource", server.oauthResource);
  putText("callback_port", server.callbackPort);
  if (server.args && known.has("args")) {
    next.lists.args = server.args;
    applied = true;
  }
  if (server.env && known.has("env")) {
    next.pairs.env = server.env;
    applied = true;
  }
  if (server.headers && known.has("headers")) {
    next.pairs.headers = server.headers;
    applied = true;
  }
  if (server.scope && surface.scopes.some((item) => item.id === server.scope)) {
    next.scope = server.scope;
    applied = true;
  }
  if (!applied) return { error: FORM_TEXT.pasteUnrecognized };
  const ignored: string[] = [];
  if (server.headers && server.headers.length > 0 && !known.has("headers")) ignored.push("Headers");
  if (server.env && server.env.length > 0 && !known.has("env")) ignored.push("环境变量");
  if (server.args && server.args.length > 0 && !known.has("args")) ignored.push("参数");
  if (server.command && !known.has("command")) ignored.push("启动命令");
  if (server.url && !known.has("url")) ignored.push("URL");
  return { draft: next, notice: ignored.length > 0 ? ignoredPasteMessage(ignored) : null };
}

export function pairCopyText(pair: McpPair): string {
  return `${pair.key}=${pair.value}`;
}

function validateField(field: McpField, draft: McpFormDraft, existingNames: readonly string[]): string | null {
  if (field.control === "list" || field.rule === "arg-list") {
    return validateList(draft.lists[field.id] ?? []);
  }
  if (field.control === "pairs" || field.rule === "pairs-env" || field.rule === "pairs-header") {
    return validatePairs(field, draft.pairs[field.id] ?? []);
  }
  const value = draft.values[field.id] ?? "";
  if (field.rule === "server-name") return validateServerName(value, existingNames);
  if (field.rule === "url") return validateUrl(field, value);
  if (field.rule === "env-name") return validateEnvName(field, value);
  if (field.rule === "port") return validatePort(field, value);
  if (field.rule === "command") return validateCommand(field, value);
  if (/[\r\n]/.test(value)) return newlineMessage(field.label);
  if (field.required && !value.trim()) return requiredMessage(field.label);
  return null;
}

function validateServerName(value: string, existingNames: readonly string[]): string | null {
  const name = value.trim();
  if (!name || [...name].some((ch) => isBlankOrControl(ch))) return FORM_TEXT.nameInvalid;
  if (existingNames.some((item) => item === name)) return FORM_TEXT.duplicateName;
  return null;
}

function validateUrl(field: McpField, value: string): string | null {
  const url = value.trim();
  if (!url) return field.required ? requiredMessage(field.label) : null;
  if (/\s/.test(url)) return FORM_TEXT.urlSpace;
  if (!/^https?:\/\/\S+$/i.test(url) || /^https?:\/\/$/i.test(url)) return FORM_TEXT.urlScheme;
  return null;
}

function validateEnvName(field: McpField, value: string): string | null {
  const name = value.trim();
  if (!name) return field.required ? requiredMessage(field.label) : null;
  if (name.includes("=") || [...name].some((ch) => isBlankOrControl(ch))) return invalidEnvName(name);
  return null;
}

function validatePort(field: McpField, value: string): string | null {
  const port = value.trim();
  if (!port) return field.required ? requiredMessage(field.label) : null;
  if (!/^[0-9]+$/.test(port) || port === "0") return FORM_TEXT.portInvalid;
  return null;
}

function validateCommand(field: McpField, value: string): string | null {
  if (/[\r\n]/.test(value)) return FORM_TEXT.commandNewline;
  if (!value.trim()) return field.required ? requiredMessage(field.label) : null;
  return null;
}

function validateList(values: string[]): string | null {
  for (const item of values) {
    if (item.trim() && /[\r\n]/.test(item)) return FORM_TEXT.argNewline;
  }
  return null;
}

function validatePairs(field: McpField, pairs: McpPair[]): string | null {
  const header = field.rule === "pairs-header";
  const seen = new Set<string>();
  for (const pair of pairs) {
    const key = pair.key.trim();
    const value = pair.value;
    if (!key && !value.trim()) continue;
    if (!key) return FORM_TEXT.emptyKey;
    if (header) {
      if ([...key].some((ch) => isBlankOrControl(ch))) return invalidHeaderName(key);
      if (/[\r\n]/.test(value)) return FORM_TEXT.headerValueNewline;
    } else if (key.includes("=") || [...key].some((ch) => isBlankOrControl(ch))) {
      return invalidEnvName(key);
    } else if (/[\r\n]/.test(value)) {
      return FORM_TEXT.envValueNewline;
    }
    if (seen.has(key)) return header ? duplicateHeaderName(key) : duplicateEnvName(key);
    seen.add(key);
  }
  return null;
}

function filledPairs(pairs: McpPair[]): McpPair[] {
  return pairs
    .filter((pair) => pair.key.trim() || pair.value.trim())
    .map((pair) => ({ key: pair.key.trim(), value: pair.value }));
}

function pairsFromJson(value: unknown): McpPair[] | null {
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) return pairsFromLineList(value);
    const pairs: McpPair[] = [];
    for (const item of value) {
      const record = asRecord(item);
      if (!record) return null;
      const key = stringField(record, "key") ?? stringField(record, "name");
      const pairValue = record.value;
      if (!key || typeof pairValue !== "string") return null;
      pairs.push({ key, value: pairValue });
    }
    return pairs.length > 0 ? pairs : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const entries = Object.entries(record);
  if (entries.length === 0 || entries.some(([, item]) => typeof item !== "string")) return null;
  return entries.map(([key, item]) => ({ key, value: item as string }));
}

function pairsFromLines(text: string): McpPair[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 1 && !lines[0].includes("=") && !/^[^:\s]+:\s+\S/.test(lines[0])) return null;
  return pairsFromLineList(lines);
}

function pairsFromLineList(lines: string[]): McpPair[] | null {
  const pairs: McpPair[] = [];
  for (const line of lines) {
    const pair = splitPairLine(line.trim());
    if (!pair) return null;
    pairs.push(pair);
  }
  return pairs.length > 0 ? pairs : null;
}

function splitPairLine(line: string): McpPair | null {
  const eq = line.indexOf("=");
  const colon = line.indexOf(":");
  if (eq >= 0 && (colon < 0 || eq < colon)) {
    const key = line.slice(0, eq).trim();
    if (!key) return null;
    return { key, value: line.slice(eq + 1).trim() };
  }
  if (colon >= 0) {
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key || !value || /\s/.test(key)) return null;
    return { key, value };
  }
  return null;
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function looksLikeServer(record: Record<string, unknown>): boolean {
  return ["command", "url", "serverUrl", "httpUrl", "args", "env", "environment", "headers", "httpHeaders", "type", "transport"].some(
    (key) => key in record,
  );
}

function serverFrom(record: Record<string, unknown>, fallbackName?: string): ParsedServer | null {
  const listed = readStringList(record.args);
  if (listed === null) return null;
  let args = listed;
  let command = stringField(record, "command");
  if (Array.isArray(record.command)) {
    if (record.command.length === 0 || record.command.some((item) => typeof item !== "string")) return null;
    const [first, ...rest] = record.command as string[];
    command = first;
    args ??= rest;
  } else if ("command" in record && typeof record.command !== "string") {
    return null;
  }
  const env = readOptionalPairs(record.env ?? record.environment);
  const headers = readOptionalPairs(record.headers ?? record.httpHeaders);
  if (env === null || headers === null) return null;
  const name = stringField(record, "name") ?? fallbackName;
  return {
    name,
    transport: stringField(record, "type") ?? stringField(record, "transport"),
    command,
    args,
    env,
    url: stringField(record, "url") ?? stringField(record, "serverUrl") ?? stringField(record, "httpUrl"),
    headers,
    bearer: stringField(record, "bearer_token_env_var") ?? stringField(record, "bearerTokenEnvVar"),
    scope: stringField(record, "scope"),
    clientId: stringField(record, "client_id") ?? stringField(record, "clientId"),
    clientSecret: stringField(record, "client_secret") ?? stringField(record, "clientSecret"),
    oauthResource: stringField(record, "oauth_resource") ?? stringField(record, "oauthResource"),
    callbackPort:
      stringField(record, "callback_port") ??
      (typeof record.callbackPort === "number" ? String(record.callbackPort) : stringField(record, "callbackPort")),
  };
}

function readStringList(value: unknown): string[] | undefined | null {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return null;
  return value;
}

function readOptionalPairs(value: unknown): McpPair[] | undefined | null {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    if (value.every((item) => typeof item === "string")) return pairsFromLineList(value);
    const pairs: McpPair[] = [];
    for (const item of value) {
      const record = asRecord(item);
      if (!record) return null;
      const key = stringField(record, "key") ?? stringField(record, "name");
      if (!key || typeof record.value !== "string") return null;
      pairs.push({ key, value: record.value });
    }
    return pairs;
  }
  const record = asRecord(value);
  if (!record) return null;
  const pairs: McpPair[] = [];
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string") return null;
    pairs.push({ key, value: item });
  }
  return pairs;
}

function matchTransport(surface: McpSurface, server: ParsedServer): string | null {
  const ids = new Set(surface.transports.map((item) => item.id));
  const pick = (id: string) => (ids.has(id) ? id : null);
  const normalized = server.transport?.trim().toLowerCase().replace(/-/g, "_") ?? "";
  if (normalized === "stdio") return pick("stdio");
  if (normalized === "sse") return pick("sse") ?? pick("streamable_http") ?? pick("http");
  if (normalized === "http" || normalized === "streamable_http") {
    if (ids.has("streamable_http") && !ids.has("http")) return "streamable_http";
    if (ids.has("http")) return "http";
    return pick("streamable_http");
  }
  if (normalized && ids.has(normalized)) return normalized;
  if (server.url && !server.command) return pick("streamable_http") ?? pick("http") ?? pick("sse");
  if (server.command && !server.url) return pick("stdio");
  return null;
}

function isBlankOrControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return /\s/u.test(ch) || code <= 31 || (code >= 127 && code <= 159);
}
