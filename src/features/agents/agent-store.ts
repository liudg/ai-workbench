// 各 Agent / 实例的能力、本机安装情况与实例列表。整个应用一份，第一次用到时向 daemon 要。

import { create } from "zustand";

import { evictSubscriptionUsage } from "@/features/panel/headless";
import { daemon, TOPIC_AGENT_INSTANCES } from "@/lib/daemon";
import { userFacingMessage } from "@/lib/user-facing";
import {
  AGENT_LABELS,
  defaultInstanceId,
  effectiveInstanceId,
  type AgentInstallation,
  type AgentInstance,
  type AgentKind,
  type AgentProfile,
} from "@/types";
import { agentInstallations, agentProfiles, evictCatalog, listInstances } from "./api";

type AgentProfilesMap = Partial<Record<string, AgentProfile>>;

export function indexProfiles(list: readonly AgentProfile[]): AgentProfilesMap {
  const map: AgentProfilesMap = {};
  for (const item of list) {
    map[effectiveInstanceId(item.kind, item.instance_id)] = item;
  }
  for (const item of list) {
    if (!map[item.kind]) {
      const isNonDefault = Boolean(
        item.instance_id &&
          effectiveInstanceId(item.kind, item.instance_id) !== defaultInstanceId(item.kind),
      );
      map[item.kind] = isNonDefault
        ? {
            ...item,
            instance_id: undefined,
            display_name: AGENT_LABELS[item.kind],
            accent_color: null,
          }
        : item;
    }
  }
  return map;
}

interface AgentState {
  profiles: AgentProfilesMap;
  /** 还没检测完时为 null。 */
  installations: AgentInstallation[] | null;
  /** 设置页的检测更新正在进行。 */
  installationsLoading: boolean;
  installationError: string | null;
  /** 已加载的实例列表（来自 TOPIC_AGENT_INSTANCES 单一订阅或首次 RPC 兜底）。 */
  instances: AgentInstance[] | null;
}

const useAgentStore = create<AgentState>()(() => ({
  profiles: {},
  installations: null,
  installationsLoading: false,
  installationError: null,
  instances: null,
}));

function instanceFingerprint(item: AgentInstance): string {
  return JSON.stringify([
    item.id,
    item.kind,
    item.updatedAt,
    item.enabled,
    item.isDefault,
    item.sortOrder,
    item.displayName,
    item.accentColor ?? null,
    item.isolationMode,
    item.homePath ?? null,
    item.sharedHomePath ?? null,
    item.binaryPath ?? null,
    item.launchArgs === undefined ? "__undef__" : item.launchArgs,
    item.environment === undefined
      ? "__undef__"
      : item.environment === null
        ? null
        : item.environment.map((env) => [
            env.name,
            env.value,
            Boolean(env.sensitive),
            Boolean(env.valueRedacted),
          ]),
  ]);
}

let instancesWatcherBound = false;
let topicInstancesReceived = false;
let lastInstanceSnapshots: Map<string, { kind: AgentKind; instanceId: string; fp: string }> | null =
  null;
let lastInstancesOrderKey: string | null = null;
let instancesRevision = 0;

let profilesRequested = false;
let profilesStartedSeq = 0;
let profilesAppliedSeq = 0;
let profilesInflight: { key: string; promise: Promise<void> } | null = null;

let installationsRequested = false;
let updatesRequested = false;
/** 已经拿到带更新信息的列表。之后到的只看本机的结果不能把它盖掉。 */
let updatesLoaded = false;
let installationsStartedSeq = 0;
let installationsAppliedSeq = 0;
let pendingUpdateChecks = 0;
let installationsInflight: { key: string; promise: Promise<void> } | null = null;

let fallbackInstancesRequested = false;
let fallbackStartedSeq = 0;
let fallbackAppliedSeq = 0;
let seeded = false;

/** 模块级单一实例指纹对比：实例配置变更或被删除时驱逐对应目录/用量缓存，并合并触发能力与安装刷新。 */
export function syncAgentInstancesSnapshot(instances: readonly AgentInstance[] | undefined) {
  if (!instances || seeded) return;
  if (instances.length === 0 && lastInstanceSnapshots === null) return;

  const nextMap = new Map<string, { kind: AgentKind; instanceId: string; fp: string }>();
  const orderParts: string[] = [];
  for (const item of instances) {
    const key = effectiveInstanceId(item.kind, item.id);
    const fp = instanceFingerprint(item);
    nextMap.set(key, { kind: item.kind, instanceId: item.id, fp });
    orderParts.push(key);
  }
  const orderKey = orderParts.join("|");

  if (lastInstanceSnapshots === null) {
    lastInstanceSnapshots = nextMap;
    lastInstancesOrderKey = orderKey;
    return;
  }

  let changed = orderKey !== lastInstancesOrderKey;
  for (const [key, prev] of lastInstanceSnapshots) {
    const next = nextMap.get(key);
    if (!next || next.fp !== prev.fp) {
      evictCatalog(prev.kind, prev.instanceId);
      evictSubscriptionUsage(prev.kind, prev.instanceId);
      changed = true;
    }
  }
  for (const [key, next] of nextMap) {
    if (!lastInstanceSnapshots.has(key)) {
      evictCatalog(next.kind, next.instanceId);
      evictSubscriptionUsage(next.kind, next.instanceId);
      changed = true;
    }
  }

  lastInstanceSnapshots = nextMap;
  lastInstancesOrderKey = orderKey;

  if (changed) {
    instancesRevision += 1;
    void refreshProfiles();
    if (installationsRequested) {
      void refreshInstallations({ preserveUpdates: true });
    }
  }
}

function ensureAgentInstancesWatcher() {
  if (instancesWatcherBound) return;
  instancesWatcherBound = true;
  // 只挂被动订阅回调，不在此主动调 daemon.start()，避免纯单测进程被重连定时器挂住。
  daemon.subscribe(TOPIC_AGENT_INSTANCES, (raw) => {
    if (Array.isArray(raw)) {
      topicInstancesReceived = true;
      const list = raw as AgentInstance[];
      if (!seeded) {
        useAgentStore.setState({ instances: list });
      }
      syncAgentInstancesSnapshot(list);
    }
  });
}

export function refreshProfiles(): Promise<void> {
  if (seeded) return Promise.resolve();
  ensureAgentInstancesWatcher();
  const key = String(instancesRevision);
  if (profilesInflight && profilesInflight.key === key) {
    return profilesInflight.promise;
  }
  profilesRequested = true;
  const seq = ++profilesStartedSeq;
  const promise = agentProfiles()
    .then((list) => {
      if (seeded || seq < profilesAppliedSeq) return;
      profilesAppliedSeq = seq;
      useAgentStore.setState({ profiles: indexProfiles(list) });
    })
    .catch(() => {
      if (Object.keys(useAgentStore.getState().profiles).length === 0) {
        profilesRequested = false;
      }
    })
    .finally(() => {
      if (profilesInflight?.promise === promise) {
        profilesInflight = null;
      }
    });
  profilesInflight = { key, promise };
  return promise;
}

export function loadProfiles() {
  ensureAgentInstancesWatcher();
  if (profilesRequested) return;
  void refreshProfiles();
}

export function loadFallbackInstances() {
  ensureAgentInstancesWatcher();
  daemon.start();
  if (topicInstancesReceived || fallbackInstancesRequested || seeded) return;
  fallbackInstancesRequested = true;
  const seq = ++fallbackStartedSeq;
  listInstances().then(
    (instances) => {
      if (seeded || topicInstancesReceived || seq < fallbackAppliedSeq) return;
      fallbackAppliedSeq = seq;
      useAgentStore.setState({ instances });
      syncAgentInstancesSnapshot(instances);
    },
    () => {
      if (!useAgentStore.getState().instances) {
        fallbackInstancesRequested = false;
      }
    },
  );
}

/** 失败时留着上次的列表（没有就仍为 null），只给出原因。检测失败不等于没装。 */
export function refreshInstallations(
  options: Parameters<typeof agentInstallations>[0] & { preserveUpdates?: boolean } = {},
): Promise<void> {
  if (seeded) return Promise.resolve();
  ensureAgentInstancesWatcher();
  const { checkUpdates, preserveUpdates, ...rpcOptions } = options;
  const key = `${instancesRevision}:${Boolean(checkUpdates)}:${Boolean(rpcOptions.refreshCatalogs)}:${Boolean(preserveUpdates)}`;
  if (installationsInflight && installationsInflight.key === key) {
    return installationsInflight.promise;
  }
  installationsRequested = true;
  const seq = ++installationsStartedSeq;
  if (checkUpdates) {
    updatesRequested = true;
    pendingUpdateChecks += 1;
    useAgentStore.setState({ installationsLoading: true, installationError: null });
  }
  let promise: Promise<void> | undefined;
  promise = (async () => {
    try {
      const installations = await agentInstallations({ ...rpcOptions, checkUpdates });
      if (seeded || seq < installationsAppliedSeq) return;
      if (checkUpdates) {
        updatesLoaded = true;
      } else if (updatesLoaded && !preserveUpdates) {
        return;
      }
      installationsAppliedSeq = seq;
      useAgentStore.setState((prev) => {
        if (!checkUpdates && updatesLoaded && preserveUpdates && prev.installations) {
          const prevByKey = new Map(
            prev.installations.map((item) => [
              effectiveInstanceId(item.kind, item.instance_id),
              item,
            ]),
          );
          const merged = installations.map((item) => {
            const old = prevByKey.get(effectiveInstanceId(item.kind, item.instance_id));
            return old
              ? {
                  ...item,
                  latest_version: old.latest_version,
                  update_available: old.update_available,
                  update_via: old.update_via,
                }
              : item;
          });
          return { installations: merged, installationError: null };
        }
        return { installations, installationError: null };
      });
    } catch (error) {
      if (!seeded && seq >= installationsAppliedSeq) {
        if (!useAgentStore.getState().installations) {
          installationsRequested = false;
        }
        useAgentStore.setState({ installationError: userFacingMessage(error) });
      }
    } finally {
      if (installationsInflight?.promise === promise) {
        installationsInflight = null;
      }
      if (checkUpdates) {
        pendingUpdateChecks = Math.max(0, pendingUpdateChecks - 1);
        if (!seeded && pendingUpdateChecks === 0) {
          useAgentStore.setState({ installationsLoading: false });
        }
      }
    }
  })();
  installationsInflight = { key, promise };
  return promise;
}

export function loadInstallations() {
  ensureAgentInstancesWatcher();
  if (!installationsRequested) void refreshInstallations();
}

/** 设置页：本次运行第一次打开时顺带查一次更新。 */
export function loadInstallationUpdates() {
  ensureAgentInstancesWatcher();
  if (!updatesRequested) void refreshInstallations({ checkUpdates: true });
}

/** 开发样例页：直接给出能力和安装情况，不向 daemon 要。 */
export function seedAgents(
  profiles: AgentProfilesMap,
  installations: AgentInstallation[],
  instances?: AgentInstance[] | null,
) {
  seeded = true;
  profilesRequested = true;
  installationsRequested = true;
  updatesRequested = true;
  fallbackInstancesRequested = true;
  pendingUpdateChecks = 0;
  useAgentStore.setState({
    profiles,
    installations,
    installationsLoading: false,
    instances: instances ?? null,
  });
}

export function useAgentState<T>(select: (state: AgentState) => T): T {
  return useAgentStore(select);
}
