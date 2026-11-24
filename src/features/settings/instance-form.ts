// 多实例表单与轻量文本生成配置的纯模型（能力门控、参数分词、掩码密钥保留）。
// 不依赖 DOM，可在 Node 单测直接验证。

import { profileForSessionAgent } from "../../shared/agent/identity.ts";
import type { UpsertInstanceInput } from "../agents/index.ts";
import {
  AGENT_LABELS,
  SECRET_REDACTED,
  defaultInstanceId,
  type AgentCapabilities,
  type AgentEnvVar,
  type AgentInstance,
  type AgentKind,
  type AgentProfile,
  type IsolationMode,
  type TextGenHttpProtocol,
  type TextGenMode,
  type TextGenSettings,
} from "../../types/index.ts";

export const ISOLATION_LABELS: Record<IsolationMode, string> = {
  hostDefault: "宿主默认目录",
  isolatedHome: "独立配置目录",
  shadowHome: "影子目录（共享技能与历史）",
};

export const ISOLATION_HINTS: Record<IsolationMode, string> = {
  hostDefault: "沿用宿主机全局默认配置与登录状态。",
  isolatedHome: "独立存放凭据、配置与会话缓存，与其他实例完全隔离。",
  shadowHome: "独立保存登录凭据与模型缓存，软链共享主目录的技能与历史。",
};

export interface IsolationOption {
  id: IsolationMode;
  label: string;
  hint: string;
}

/** 严格由适配器 `capabilities.supports_shadow_home` 驱动，禁止按 Agent 名称硬编码分支。 */
export function availableIsolationModes(
  capabilities: Pick<AgentCapabilities, "supports_shadow_home"> | undefined,
): IsolationOption[] {
  const modes: IsolationMode[] = ["hostDefault", "isolatedHome"];
  if (capabilities?.supports_shadow_home) {
    modes.push("shadowHome");
  }
  return modes.map((id) => ({
    id,
    label: ISOLATION_LABELS[id],
    hint: ISOLATION_HINTS[id],
  }));
}

export const ACCENT_COLOR_PRESETS: readonly { value: string; label: string }[] = [
  { value: "#3b82f6", label: "蔚蓝" },
  { value: "#10b981", label: "翠绿" },
  { value: "#f59e0b", label: "琥珀" },
  { value: "#ef4444", label: "珊瑚" },
  { value: "#8b5cf6", label: "靛紫" },
  { value: "#ec4899", label: "玫红" },
  { value: "#06b6d4", label: "青蓝" },
];

export function builtinDefaultInstance(kind: AgentKind, displayName?: string): AgentInstance {
  return {
    id: defaultInstanceId(kind),
    kind,
    displayName: displayName?.trim() || AGENT_LABELS[kind],
    accentColor: null,
    binaryPath: null,
    launchArgs: [],
    environment: [],
    isolationMode: "hostDefault",
    homePath: null,
    sharedHomePath: null,
    enabled: true,
    isDefault: true,
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

export function isDefaultInstanceModified(
  inst: AgentInstance,
  defaultLabel: string = AGENT_LABELS[inst.kind],
): boolean {
  if (!inst.isDefault) return false;
  if (inst.updatedAt > 0) return true;
  if (!inst.enabled) return true;
  if (inst.isolationMode !== "hostDefault") return true;
  if (inst.accentColor?.trim()) return true;
  if (inst.binaryPath?.trim()) return true;
  if (inst.homePath?.trim()) return true;
  if (inst.sharedHomePath?.trim()) return true;
  if ((inst.launchArgs?.length ?? 0) > 0) return true;
  if ((inst.environment?.length ?? 0) > 0) return true;
  if (inst.displayName.trim() !== defaultLabel.trim()) return true;
  return false;
}

function quoteSingleLaunchArg(arg: string): string {
  if (!/\s|["']/.test(arg)) return arg;
  if (!arg.includes('"')) return `"${arg}"`;
  if (!arg.includes("'")) return `'${arg}'`;
  return `'${arg.replace(/'/g, "'\"'\"'")}'`;
}

function stripMatchingOuterQuotes(line: string): string {
  if (line.length < 2) return line;
  const first = line[0];
  const last = line[line.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    const inner = line.slice(1, -1);
    if (!inner.includes(first)) return inner;
  }
  return line;
}

export function formatLaunchArgs(args?: readonly string[] | null): string {
  const list = args ?? [];
  if (list.length === 0) return "";
  if (list.length === 1) return quoteSingleLaunchArg(list[0]!);
  return list.join("\n");
}

/** 支持多行（每行一个参数）或单行空格分词（兼容引号包裹含空格路径）。 */
export function parseLaunchArgs(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.includes("\n")) {
    return trimmed
      .split(/\r?\n/)
      .map((line) => stripMatchingOuterQuotes(line.trim()))
      .filter((line) => line.length > 0);
  }
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

let nextEnvVarDraftId = 1;

function nextEnvVarId(): string {
  const id = `env-${nextEnvVarDraftId}`;
  nextEnvVarDraftId += 1;
  return id;
}

function isRedactedSecretEnvVar(
  item: Pick<AgentEnvVar, "sensitive" | "value" | "valueRedacted">,
): boolean {
  return Boolean(item.sensitive && (item.valueRedacted || item.value === SECRET_REDACTED));
}

function toPersistedEnvVar(
  name: string,
  item: Pick<AgentEnvVar, "sensitive" | "value" | "valueRedacted">,
): AgentEnvVar {
  const redacted = isRedactedSecretEnvVar(item);
  return {
    name,
    value: redacted ? "" : item.value,
    sensitive: Boolean(item.sensitive),
    ...(redacted ? { valueRedacted: true } : {}),
  };
}

export interface EnvVarDraft {
  id: string;
  sourceName?: string;
  name: string;
  value: string;
  sensitive: boolean;
  hadSavedSecret: boolean;
  valueRedacted: boolean;
}

function isEnvRowRedacted(row: Pick<EnvVarDraft, "hadSavedSecret" | "sensitive" | "name" | "sourceName">): boolean {
  return Boolean(
    row.hadSavedSecret &&
      row.sensitive &&
      row.sourceName !== undefined &&
      row.name.trim() === row.sourceName,
  );
}

export function createEmptyEnvVarDraft(): EnvVarDraft {
  return {
    id: nextEnvVarId(),
    name: "",
    value: "",
    sensitive: false,
    hadSavedSecret: false,
    valueRedacted: false,
  };
}

export interface InstanceFormDraft {
  id?: string;
  kind: AgentKind;
  isDefault: boolean;
  enabled: boolean;
  sortOrder?: number;
  displayName: string;
  accentColor: string;
  isolationMode: IsolationMode;
  homePath: string;
  sharedHomePath: string;
  binaryPath: string;
  launchArgsText: string;
  environment: EnvVarDraft[];
}

export function createInstanceFormDraft(params: {
  kind: AgentKind;
  instance?: AgentInstance | null;
  capabilities?: Pick<AgentCapabilities, "supports_shadow_home">;
}): InstanceFormDraft {
  const { kind, instance, capabilities } = params;
  if (instance) {
    const mode: IsolationMode =
      instance.isolationMode === "shadowHome" && !capabilities?.supports_shadow_home
        ? "isolatedHome"
        : instance.isolationMode;
    return {
      id: instance.id,
      kind: instance.kind,
      isDefault: instance.isDefault,
      enabled: instance.enabled,
      sortOrder: instance.sortOrder,
      displayName: instance.displayName,
      accentColor: instance.accentColor?.trim() ?? "",
      isolationMode: mode,
      homePath: instance.homePath ?? "",
      sharedHomePath: instance.sharedHomePath ?? "",
      binaryPath: instance.binaryPath ?? "",
      launchArgsText: formatLaunchArgs(instance.launchArgs),
      environment: (instance.environment ?? []).map((item) => {
        const redacted = isRedactedSecretEnvVar(item);
        return {
          id: nextEnvVarId(),
          sourceName: item.name.trim(),
          name: item.name,
          value: redacted ? "" : item.value,
          sensitive: Boolean(item.sensitive),
          hadSavedSecret: redacted,
          valueRedacted: redacted,
        };
      }),
    };
  }

  return {
    kind,
    isDefault: false,
    enabled: true,
    displayName: "",
    accentColor: ACCENT_COLOR_PRESETS[0].value,
    isolationMode: "isolatedHome",
    homePath: "",
    sharedHomePath: "",
    binaryPath: "",
    launchArgsText: "",
    environment: [],
  };
}

export function updateEnvVarName(row: EnvVarDraft, nextName: string): EnvVarDraft {
  const next = { ...row, name: nextName };
  return { ...next, valueRedacted: isEnvRowRedacted(next) };
}

export function updateEnvVarValue(row: EnvVarDraft, nextValue: string): EnvVarDraft {
  return {
    ...row,
    value: nextValue,
    hadSavedSecret: false,
    valueRedacted: false,
  };
}

export function toggleEnvVarSensitive(row: EnvVarDraft, sensitive: boolean): EnvVarDraft {
  if (!sensitive) {
    return {
      ...row,
      sensitive: false,
      ...(row.valueRedacted ? { value: "" } : {}),
      hadSavedSecret: false,
      valueRedacted: false,
    };
  }
  const next = { ...row, sensitive: true };
  return { ...next, valueRedacted: isEnvRowRedacted(next) };
}

function serializeEnvVarDrafts(rows: readonly EnvVarDraft[]): AgentEnvVar[] {
  const out: AgentEnvVar[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    const redacted = isEnvRowRedacted(row);
    out.push({
      name,
      value: redacted ? "" : row.value,
      sensitive: Boolean(row.sensitive),
      ...(redacted ? { valueRedacted: true } : {}),
    });
  }
  return out;
}

export function draftToUpsertInput(
  draft: InstanceFormDraft,
  capabilities?: Pick<AgentCapabilities, "supports_shadow_home">,
): UpsertInstanceInput {
  const isolationMode: IsolationMode =
    draft.isolationMode === "shadowHome" && !capabilities?.supports_shadow_home
      ? "isolatedHome"
      : draft.isolationMode;

  return {
    ...(draft.id ? { id: draft.id } : {}),
    kind: draft.kind,
    displayName: draft.displayName.trim(),
    accentColor: draft.accentColor.trim() || null,
    enabled: draft.enabled,
    binaryPath: draft.binaryPath.trim() || null,
    launchArgs: parseLaunchArgs(draft.launchArgsText),
    environment: serializeEnvVarDrafts(draft.environment),
    isolationMode,
    homePath: isolationMode === "hostDefault" ? null : draft.homePath.trim() || null,
    sharedHomePath:
      isolationMode === "shadowHome" ? draft.sharedHomePath.trim() || null : null,
    ...(draft.sortOrder !== undefined ? { sortOrder: draft.sortOrder } : {}),
  };
}

/** 在列表行直接切换启用状态时，完整保留已脱敏的敏感环境变量。 */
export function instanceToUpsertInput(
  inst: AgentInstance,
  enabled: boolean,
): UpsertInstanceInput {
  const environment: AgentEnvVar[] = (inst.environment ?? []).map((item) =>
    toPersistedEnvVar(item.name, item),
  );
  return {
    id: inst.id,
    kind: inst.kind,
    displayName: inst.displayName,
    accentColor: inst.accentColor ?? null,
    enabled,
    binaryPath: inst.binaryPath ?? null,
    launchArgs: inst.launchArgs ?? [],
    environment,
    isolationMode: inst.isolationMode,
    homePath: inst.homePath ?? null,
    sharedHomePath: inst.sharedHomePath ?? null,
    sortOrder: inst.sortOrder,
  };
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export interface TextGenFormDraft {
  mode: TextGenMode;
  instanceId: string;
  model: string;
  autoTitle: boolean;
  protocol: TextGenHttpProtocol;
  baseUrl: string;
  savedBaseUrl: string;
  httpModel: string;
  apiKey: string;
  hadSavedApiKey: boolean;
  apiKeyRedacted: boolean;
}

export function createTextGenDraft(settings?: TextGenSettings | null): TextGenFormDraft {
  const http = settings?.http;
  const redacted = Boolean(http && (http.apiKeyRedacted || http.apiKey === SECRET_REDACTED));
  const baseUrl = http?.baseUrl ?? "";
  return {
    mode: settings?.mode ?? "auto",
    instanceId: settings?.instanceId?.trim() ?? "",
    model: settings?.model?.trim() ?? "",
    autoTitle: settings?.autoTitle ?? true,
    protocol: http?.protocol ?? "openAi",
    baseUrl,
    savedBaseUrl: normalizeBaseUrl(baseUrl),
    httpModel: http?.model ?? "",
    apiKey: redacted ? "" : (http?.apiKey ?? ""),
    hadSavedApiKey: redacted,
    apiKeyRedacted: redacted,
  };
}

export function updateTextGenBaseUrl(
  draft: TextGenFormDraft,
  nextBaseUrl: string,
): TextGenFormDraft {
  const apiKeyRedacted =
    draft.hadSavedApiKey && normalizeBaseUrl(nextBaseUrl) === normalizeBaseUrl(draft.savedBaseUrl);
  return {
    ...draft,
    baseUrl: nextBaseUrl,
    apiKeyRedacted,
  };
}

export function updateTextGenApiKey(
  draft: TextGenFormDraft,
  nextValue: string,
): TextGenFormDraft {
  return {
    ...draft,
    apiKey: nextValue,
    hadSavedApiKey: false,
    apiKeyRedacted: false,
  };
}

export function textGenDraftToSettings(draft: TextGenFormDraft): TextGenSettings {
  const trimmedBaseUrl = draft.baseUrl.trim();
  const baseUrlUnchanged =
    normalizeBaseUrl(draft.baseUrl) === normalizeBaseUrl(draft.savedBaseUrl);
  const keepRedacted =
    baseUrlUnchanged &&
    (draft.hadSavedApiKey || draft.apiKeyRedacted || draft.apiKey === SECRET_REDACTED);
  const hasHttp =
    draft.mode === "http" ||
    Boolean(trimmedBaseUrl || draft.httpModel.trim() || draft.apiKey || keepRedacted);
  return {
    mode: draft.mode,
    instanceId: draft.instanceId.trim() || null,
    model: draft.model.trim() || null,
    autoTitle: draft.autoTitle,
    http: hasHttp
      ? {
          protocol: draft.protocol,
          baseUrl: trimmedBaseUrl,
          model: draft.httpModel.trim(),
          apiKey: keepRedacted ? "" : draft.apiKey,
          ...(keepRedacted ? { apiKeyRedacted: true } : {}),
        }
      : null,
  };
}

/** 仅返回能力声明支持 `supports_text_generation` 的实例，严禁按 Agent 名称分支。 */
export function filterTextGenCapableInstances(
  instances: readonly AgentInstance[] | null | undefined,
  profiles: Partial<Record<string, AgentProfile>>,
): AgentInstance[] {
  if (!instances) return [];
  return instances.filter((inst) => {
    if (!inst.enabled) return false;
    const profile = profileForSessionAgent(inst.kind, profiles, inst.id);
    return profile?.capabilities.supports_text_generation === true;
  });
}
