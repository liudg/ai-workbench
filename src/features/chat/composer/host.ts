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
import type { FileRef } from "./file-refs";
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
  /** 还没检测完本机 Agent 时为 null。换不了 Agent 的会话只有当前这一个。 */
  options: AgentOption[] | null;
  selected: AgentKind;
  /** 有别的 Agent 可换时才有。 */
  switcher: AgentSwitcher | null;
}

export interface AgentSwitcher {
  /** 现在换不了的原因。有值时别的 Agent 的模型只能看，不能选。 */
  blocked: string | null;
  /** 竖栏切到别的 Agent 时读它的模型。上次的先给 `show`，新的到了再给一次；都没有时 reject。 */
  loadModels: (agent: AgentKind, show: (models: AgentModelOption[]) => void) => Promise<void>;
  /** 选了别的 Agent 的模型：换成这个 Agent，用这个模型。 */
  onPick: (agent: AgentKind, model: AgentModelOption) => void;
}

/** 新工作树的起点。`base` 为空表示项目目录现在所在的分支。 */
export interface WorktreeStart {
  base: string | null;
  carry: boolean;
  onPick: (base: string | null, carry: boolean) => void;
}

/** 工作树任务在工作树和项目目录之间交接。 */
export interface WorktreeHandOffLine {
  /** 已交给项目目录时是挪过去的分支。 */
  localBranch: string | null;
  /** 工作树还没有分支时预填的分支名。 */
  suggestedBranch: string;
  busy: boolean;
  /** 交给项目目录或交回工作树，失败时自己报错。 */
  onHandOff: () => void;
  /** 先给工作树建分支再交给项目目录。失败时 reject，错误显示在起名对话框里。 */
  onHandOffAs: (branch: string) => Promise<void>;
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
  /** 工作树已被清理。发消息时自动恢复，也可以点按钮先恢复。 */
  shelved?: { restoring: boolean; onRestore: () => void } | null;
  /** 新任务打开了工作树时，选起点。 */
  start?: WorktreeStart | null;
  handOff?: WorktreeHandOffLine | null;
}

export interface ComposerHost {
  /** 还没建好的新会话：第一条消息要等创建成功才清掉输入。 */
  draft: boolean;
  /** 新会话正在创建，输入先锁住。 */
  inputLocked: boolean;
  initialText: string;
  /** 框里 `@文件名` 对应的完整路径，和文字一起存。 */
  initialFileRefs: FileRef[];
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
  rememberFileRefs(refs: FileRef[]): void;
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
  /** 发送被拒时把清掉的引用放回去。 */
  restoreTextSnippets(snippets: TextSnippet[]): void;
  removeTextSnippet(id: string): void;
  updateQueued(id: string, text: string, images: string[]): Promise<void>;
  removeQueued(id: string): Promise<void>;
  steerQueued(id: string): Promise<void>;
  /** 把一条排队消息挪到侧边聊天里问。没有侧边聊天的宿主不给。 */
  openInSideChat?: (item: QueuedTurn) => void;
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
