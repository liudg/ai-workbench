// 处理应用冷启动与单实例唤醒传入的 `LaunchIntent`（命令行目录、`aiwb://` 深层链接）：
// 1. 打开目录：与现有项目比对或导入，调用 `openProject`（附带 prompt 时切到项目新对话并安全置入草稿）。
// 2. 新建提示词：切到目标项目（或独立聊天）的新对话，经隐藏字符净化与未发送草稿覆盖确认后仅写入作曲栏草稿，严禁自动发送。

import { useCallback, useEffect, useRef, useState } from "react";

import { projectsApi, type Project } from "@/features/projects";
import type { TaskEntry } from "@/features/tasks";
import { loadDraftText, newSessionKey, setDraftText } from "@/features/workspace";
import { daemon } from "@/lib/daemon";
import { drainLaunchIntents, listenLaunchIntents, type LaunchIntent } from "@/lib/native/launch";
import {
  formatHiddenCharactersWarning,
  sanitizePromptLink,
  shouldConfirmDraftOverwrite,
  type SanitizePromptOutcome,
} from "@/lib/native/prompt-link";
import { normalizePath } from "@/shared/path";
import { showError } from "@/shared/shell/error-banner";
import {
  openNewSession,
  openProject,
  selectedProjectOf,
  useNavigation,
  type MainView,
  type ProjectScope,
} from "@/shared/shell/navigation";

export interface PendingDraftOverwrite {
  draftKey: string;
  incomingPrompt: string;
  hiddenCharactersRemoved: number;
  truncated: boolean;
}

interface ActiveOverwriteRequest extends PendingDraftOverwrite {
  resolve: (confirmed: boolean) => void;
}

type SanitizedValidPrompt = Extract<SanitizePromptOutcome, { ok: true }>;

interface LaunchIntentConsumer {
  getView: () => MainView;
  setWarning: (warning: string | null) => void;
  setOverwriteRequest: (request: ActiveOverwriteRequest | null) => void;
}

// 模块级队列与活跃消费者路由：兼容 React StrictMode 首次卸载重挂，以及排空期间到达的二次单实例唤醒。
const pendingQueue: LaunchIntent[] = [];
let drainingFromRust = false;
let needsRedrain = false;
let processingQueue = false;
let activeConsumer: LaunchIntentConsumer | null = null;
let currentWarning: string | null = null;
let currentOverwrite: ActiveOverwriteRequest | null = null;

function setWarningState(next: string | null) {
  currentWarning = next;
  activeConsumer?.setWarning(next);
}

function requestOverwriteConfirmation(info: PendingDraftOverwrite): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req: ActiveOverwriteRequest = {
      ...info,
      resolve: (confirmed: boolean) => {
        if (currentOverwrite === req) {
          currentOverwrite = null;
        }
        activeConsumer?.setOverwriteRequest(null);
        resolve(confirmed);
      },
    };
    currentOverwrite = req;
    activeConsumer?.setOverwriteRequest(req);
  });
}

function pathComparisonKey(raw: string): string {
  const normalized = normalizePath(raw.trim()).replace(/\/+$/, "");
  // Windows 盘符路径或 UNC 路径大小写不敏感
  if (/^[A-Za-z]:/.test(normalized) || raw.includes("\\")) {
    return normalized.toLowerCase();
  }
  return normalized;
}

function sameDirectory(a: string, b: string): boolean {
  const ka = pathComparisonKey(a);
  const kb = pathComparisonKey(b);
  return Boolean(ka) && ka === kb;
}

function findProjectByFolder(projects: readonly Project[], folderPath: string): Project | undefined {
  return projects.find(
    (project) =>
      sameDirectory(project.path, folderPath) ||
      project.folders.some((owned) => sameDirectory(owned, folderPath)),
  );
}

function findProjectByIdentifier(projects: readonly Project[], query: string): Project | undefined {
  const trimmed = query.trim();
  if (!trimmed) return undefined;
  const byFolder = findProjectByFolder(projects, trimmed);
  if (byFolder) return byFolder;
  const lower = trimmed.toLowerCase();
  return projects.find((project) => project.id === trimmed || project.name.toLowerCase() === lower);
}

function looksLikeDirectoryPath(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\\\") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith(".\\") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("..\\")
  );
}

async function resolveOrImportDirectoryProject(dirPath: string): Promise<Project> {
  const initialProjects = await daemon.call<Project[]>("projects.list", {});
  const existing = findProjectByFolder(initialProjects, dirPath);
  if (existing) return existing;

  try {
    return await projectsApi.importProject({ path: dirPath });
  } catch (error) {
    // 软链接或大小写规范化后若已存在于项目列表中，重新读取列表匹配。
    const latestProjects = await daemon.call<Project[]>("projects.list", {}).catch(() => []);
    const matched = findProjectByFolder(latestProjects, dirPath);
    if (matched) return matched;
    throw error;
  }
}

async function applySanitizedPromptToDraft(draftKey: string, sanitized: SanitizedValidPrompt) {
  const existingText = await loadDraftText(draftKey);
  if (shouldConfirmDraftOverwrite(existingText, sanitized.prompt)) {
    const confirmed = await requestOverwriteConfirmation({
      draftKey,
      incomingPrompt: sanitized.prompt,
      hiddenCharactersRemoved: sanitized.hiddenCharactersRemoved,
      truncated: sanitized.truncated,
    });
    if (!confirmed) return;
  }

  await setDraftText(draftKey, sanitized.prompt);

  if (sanitized.hiddenCharactersRemoved > 0) {
    setWarningState(
      formatHiddenCharactersWarning(sanitized.hiddenCharactersRemoved, sanitized.truncated),
    );
  } else if (sanitized.truncated) {
    setWarningState("外部传入的提示词超过 8,000 字上限，超出部分已截断，发送前请仔细核对内容");
  }
}

async function handleSingleIntent(intent: LaunchIntent) {
  try {
    // 在执行任何页面跳转或目录导入前先校验提示词载荷，纯隐藏字符直接拦截且不离开当前会话。
    let sanitized: SanitizedValidPrompt | null = null;
    if (intent.prompt !== undefined && intent.prompt.length > 0) {
      const outcome = sanitizePromptLink(intent.prompt);
      if (!outcome.ok) {
        if (outcome.reason === "only-hidden") {
          showError("外部链接传入的提示词仅包含隐藏字符，已拦截。");
          return;
        }
      } else {
        sanitized = outcome;
      }
    }

    if (intent.kind === "directory") {
      const project = await resolveOrImportDirectoryProject(intent.path);
      if (sanitized) {
        openNewSession(project.id);
        await applySanitizedPromptToDraft(newSessionKey(project.id), sanitized);
      } else {
        const tasks = await daemon.call<TaskEntry[]>("tasks.list", {});
        const projectTaskIds = tasks
          .filter((task) => task.projectId === project.id && !task.archivedAt)
          .map((task) => task.id);
        openProject(project.id, projectTaskIds);
      }
      return;
    }

    const projectQuery = intent.project?.trim() ?? "";
    if (!sanitized && !projectQuery) {
      return;
    }

    let targetProjectId: ProjectScope;
    if (projectQuery.length > 0) {
      const projects = await daemon.call<Project[]>("projects.list", {});
      const matched = findProjectByIdentifier(projects, projectQuery);
      if (matched) {
        targetProjectId = matched.id;
      } else if (looksLikeDirectoryPath(projectQuery)) {
        const imported = await resolveOrImportDirectoryProject(projectQuery);
        targetProjectId = imported.id;
      } else {
        showError(`找不到项目：${projectQuery}`);
        return;
      }
    } else {
      const currentView = activeConsumer?.getView();
      targetProjectId = currentView ? (selectedProjectOf(currentView) ?? null) : null;
    }

    openNewSession(targetProjectId);
    if (sanitized) {
      await applySanitizedPromptToDraft(newSessionKey(targetProjectId), sanitized);
    }
  } catch (error) {
    showError(error);
  }
}

async function pumpQueue() {
  if (processingQueue || !activeConsumer) return;
  processingQueue = true;
  try {
    while (pendingQueue.length > 0 && activeConsumer) {
      const next = pendingQueue.shift()!;
      await handleSingleIntent(next);
    }
  } finally {
    processingQueue = false;
  }
}

function drainIntoQueue(drain: () => Promise<LaunchIntent[]> = drainLaunchIntents) {
  if (drainingFromRust) {
    needsRedrain = true;
    return;
  }
  drainingFromRust = true;
  needsRedrain = false;
  void drain()
    .then((intents) => {
      if (intents.length > 0) {
        pendingQueue.push(...intents);
        void pumpQueue();
      }
    })
    .catch(() => {})
    .finally(() => {
      drainingFromRust = false;
      if (needsRedrain) {
        needsRedrain = false;
        drainIntoQueue(drain);
      } else if (pendingQueue.length > 0) {
        void pumpQueue();
      }
    });
}

export interface UseLaunchIntentDeps {
  drain?: () => Promise<LaunchIntent[]>;
  listen?: (onArrival: () => void) => () => void;
}

export function useLaunchIntent(deps?: UseLaunchIntentDeps) {
  const view = useNavigation((state) => state.view);
  const viewRef = useRef(view);
  viewRef.current = view;

  const [warning, setWarning] = useState<string | null>(currentWarning);
  const [overwriteRequest, setOverwriteRequest] = useState<ActiveOverwriteRequest | null>(
    currentOverwrite,
  );

  const dismissWarning = useCallback(() => setWarningState(null), []);
  const confirmOverwrite = useCallback(() => currentOverwrite?.resolve(true), []);
  const cancelOverwrite = useCallback(() => currentOverwrite?.resolve(false), []);

  const drain = deps?.drain ?? drainLaunchIntents;
  const listen = deps?.listen ?? listenLaunchIntents;

  useEffect(() => {
    const consumer: LaunchIntentConsumer = {
      getView: () => viewRef.current,
      setWarning,
      setOverwriteRequest,
    };
    activeConsumer = consumer;
    setWarning(currentWarning);
    setOverwriteRequest(currentOverwrite);

    const onArrival = () => drainIntoQueue(drain);
    const stop = listen(onArrival);
    drainIntoQueue(drain);
    if (pendingQueue.length > 0) {
      void pumpQueue();
    }
    return () => {
      stop();
      if (activeConsumer === consumer) {
        activeConsumer = null;
      }
    };
  }, [drain, listen]);

  const overwritePrompt: PendingDraftOverwrite | null = overwriteRequest
    ? {
        draftKey: overwriteRequest.draftKey,
        incomingPrompt: overwriteRequest.incomingPrompt,
        hiddenCharactersRemoved: overwriteRequest.hiddenCharactersRemoved,
        truncated: overwriteRequest.truncated,
      }
    : null;

  return {
    warning,
    dismissWarning,
    overwritePrompt,
    confirmOverwrite,
    cancelOverwrite,
  };
}
