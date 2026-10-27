// 作曲栏要从外面拿的东西。作曲栏只认这个接口，不知道数据来自 daemon 还是还没建好的新会话。

import type { ComponentProps } from "react";

import type { AgentIdentity } from "@/shared/agent/identity";
import type { TextSnippet } from "@/shared/text-snippet";
import type {
  AgentCatalog,
  AgentKind,
  AgentModelOption,
  AgentProfile,
  Attachment,
  PermissionMenu,
  PromptAnswer,
  QueuedTurn,
  ReviewStart,
  ReviewTargets,
  SessionSandbox,
  SessionTuning,
} from "@/types";
import type { FollowUpQueueMode } from "./follow-up-queue-mode";
import type { PathPage } from "./mention-search";
import type { WorkContextPicker } from "./WorkContextPicker";

export interface AgentOption {
  kind: AgentKind;
  identity: AgentIdentity | null;
  name: string;
}

/** 模型选择器左边的 Agent 竖栏。 */
export interface AgentChoice {
  /** 还没检测完本机 Agent 时为 null。会话建好后只有当前这一个。 */
  options: AgentOption[] | null;
  selected: AgentKind;
  /** 还能换 Agent 时才有。会话建好后为 null。 */
  switcher: AgentSwitcher | null;
}

export interface AgentSwitcher {
  /** 竖栏切到别的 Agent 时读它的模型。 */
  loadModels: (agent: AgentKind) => Promise<AgentModelOption[]>;
  /** 选了别的 Agent 的模型：换成这个 Agent，用这个模型。 */
  onPick: (agent: AgentKind, model: AgentModelOption) => void;
}

/** 新会话的工作树开关，或已有会话所在的工作树。 */
export interface WorktreeLine {
  showToggle: boolean;
  pressed: boolean;
  onToggle: () => void;
  liveLabel: string;
  liveTitle: string;
  base?: string | null;
  sha?: string | null;
}

export interface ComposerHost {
  /** 还没建好的新会话：第一条消息要等创建成功才清掉输入。 */
  draft: boolean;
  /** 新会话正在创建，输入先锁住。 */
  inputLocked: boolean;
  initialText: string;
  catalog: AgentCatalog | undefined;
  catalogNotice: string | null;
  profile: AgentProfile | undefined;
  tuning: SessionTuning | undefined;
  /** 存下的权限。为空时用权限菜单里当前生效的那一档。 */
  sandbox: SessionSandbox | null;
  permissionMenu: PermissionMenu | null;
  /** 工作目录。权限里的可写目录相对它显示。 */
  projectPath: string;
  files: Attachment[];
  snippets: TextSnippet[];
  queue: QueuedTurn[];
  followUpQueueMode: FollowUpQueueMode;
  /** 分支芯片读哪里。独立聊天没有。 */
  git: { projectId: string; projectName: string; sessionId?: string } | null;
  workContext: ComponentProps<typeof WorkContextPicker> | null;
  worktree: WorktreeLine | null;
  agentChoice: AgentChoice | null;

  rememberText(text: string): void;
  /** 发出一条消息。`now` 时回合进行中也直接引导进去。失败时返回 false，输入还在。 */
  send(text: string, images: string[], now: boolean): Promise<boolean>;
  setCollaborationMode(mode: "plan" | "default"): Promise<void>;
  startReview(target: ReviewStart): Promise<void>;
  reviewTargets(): Promise<ReviewTargets>;
  answerPrompt(promptId: string, answer: PromptAnswer): Promise<boolean>;
  setSandbox(sandbox: SessionSandbox): void;
  setTuning(model: string, effort: string, serviceTier?: string | null): void;
  addAttachments(files: Attachment[]): void;
  removeAttachment(path: string): void;
  clearAttachments(): void;
  replaceAttachments(files: Attachment[]): void;
  clearTextSnippets(): void;
  updateQueued(id: string, text: string, images: string[]): Promise<void>;
  removeQueued(id: string): Promise<void>;
  steerQueued(id: string): Promise<void>;
  /** 按给定顺序逐条引导。 */
  flushQueued(ids: string[]): Promise<void>;
  setFollowUpQueueMode(mode: FollowUpQueueMode): void;
  interrupt(): void;
  setGoal(objective: string): Promise<void>;
  clearGoal(): Promise<void>;
  setGoalStatus(status: "paused" | "active"): Promise<void>;
  publishGoal(): Promise<void>;
  /** `@` 文件筛选，在会话的工作目录里找。 */
  filterPaths(query: string): Promise<PathPage>;
  reportError(error: unknown): void;
}
