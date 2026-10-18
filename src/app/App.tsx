import { lazy, Suspense } from "react";

import { CommandMenuHost } from "@/features/command-menu/CommandMenuHost";
import { userFacingMessage } from "@/lib/user-facing";
import { NewProjectDialog, Sidebar } from "@/features/sidebar";
import { RightPane, UpdateDialog } from "@/features/workspace";
import { useAppShell } from "./use-app-shell";

const DiffPreview = import.meta.env.DEV
  ? lazy(() => import("@/app/preview/DiffPreview"))
  : null;
const ComposerPreview = import.meta.env.DEV
  ? lazy(() => import("@/features/chat/composer/ComposerPreview"))
  : null;
const FilesPreview = import.meta.env.DEV
  ? lazy(() => import("@/features/panel/files/FilesPreview"))
  : null;
const ImagePanelPreview = import.meta.env.DEV
  ? lazy(() => import("@/features/panel/files/ImagePanelPreview"))
  : null;
const UsagePreview = import.meta.env.DEV
  ? lazy(() => import("@/features/workspace/UsagePreview"))
  : null;
const ActivityPreview = import.meta.env.DEV
  ? lazy(() => import("@/app/preview/ActivityPreview"))
  : null;
const SidebarPreview = import.meta.env.DEV
  ? lazy(() => import("@/features/sidebar/SidebarPreview"))
  : null;
const CodePreview = import.meta.env.DEV
  ? lazy(() => import("@/features/panel/files/CodePreview"))
  : null;
const CommandMenuPreview = import.meta.env.DEV
  ? lazy(() => import("@/features/command-menu/CommandMenuPreview"))
  : null;
const McpPreview = import.meta.env.DEV
  ? lazy(() => import("@/app/preview/McpPreview"))
  : null;
const WorkContextPreview = import.meta.env.DEV
  ? lazy(() => import("@/app/preview/WorkContextPreview"))
  : null;
const MarkdownModePreview = import.meta.env.DEV
  ? lazy(() => import("@/app/preview/MarkdownModePreview"))
  : null;
const QuestionPreview = import.meta.env.DEV
  ? lazy(() => import("@/app/preview/QuestionPreview"))
  : null;
const GitBranchPreview = import.meta.env.DEV
  ? lazy(() => import("@/app/preview/GitBranchPreview"))
  : null;
const PlanChoicePreview = import.meta.env.DEV
  ? lazy(() => import("@/app/preview/PlanChoicePreview"))
  : null;
const ThreadFindPreview = import.meta.env.DEV
  ? lazy(() => import("@/app/preview/ThreadFindPreview"))
  : null;
const AttentionPreview = import.meta.env.DEV
  ? lazy(() => import("@/app/preview/AttentionPreview"))
  : null;
const WorktreePreview = import.meta.env.DEV
  ? lazy(() => import("@/app/preview/WorktreePreview"))
  : null;

export default function App() {
  const preview = new URLSearchParams(window.location.search).get("preview");
  if (DiffPreview && preview === "diff") {
    return (
      <Suspense fallback={null}>
        <DiffPreview />
      </Suspense>
    );
  }
  if (ComposerPreview && preview === "composer") {
    return (
      <Suspense fallback={null}>
        <ComposerPreview />
      </Suspense>
    );
  }
  if (FilesPreview && preview === "files") {
    return (
      <Suspense fallback={null}>
        <FilesPreview />
      </Suspense>
    );
  }
  if (ImagePanelPreview && preview === "image") {
    return (
      <Suspense fallback={null}>
        <ImagePanelPreview />
      </Suspense>
    );
  }
  if (UsagePreview && preview === "usage") {
    return (
      <Suspense fallback={null}>
        <UsagePreview />
      </Suspense>
    );
  }
  if (ActivityPreview && preview === "activity") {
    return (
      <Suspense fallback={null}>
        <ActivityPreview />
      </Suspense>
    );
  }
  if (SidebarPreview && preview === "sidebar") {
    return (
      <Suspense fallback={null}>
        <SidebarPreview />
      </Suspense>
    );
  }
  if (CodePreview && preview === "code") {
    return (
      <Suspense fallback={null}>
        <CodePreview />
      </Suspense>
    );
  }
  if (CommandMenuPreview && preview === "command-menu") {
    return (
      <Suspense fallback={null}>
        <CommandMenuPreview />
      </Suspense>
    );
  }
  if (McpPreview && preview === "mcp") {
    return (
      <Suspense fallback={null}>
        <McpPreview />
      </Suspense>
    );
  }
  if (WorkContextPreview && preview === "work-context") {
    return (
      <Suspense fallback={null}>
        <WorkContextPreview />
      </Suspense>
    );
  }
  if (MarkdownModePreview && preview === "markdown") {
    return (
      <Suspense fallback={null}>
        <MarkdownModePreview />
      </Suspense>
    );
  }
  if (QuestionPreview && preview === "questions") {
    return (
      <Suspense fallback={null}>
        <QuestionPreview />
      </Suspense>
    );
  }
  if (GitBranchPreview && preview === "git-branch") {
    return (
      <Suspense fallback={null}>
        <GitBranchPreview />
      </Suspense>
    );
  }
  if (PlanChoicePreview && preview === "plan-choice") {
    return (
      <Suspense fallback={null}>
        <PlanChoicePreview />
      </Suspense>
    );
  }
  if (ThreadFindPreview && preview === "thread-find") {
    return (
      <Suspense fallback={null}>
        <ThreadFindPreview />
      </Suspense>
    );
  }
  if (AttentionPreview && preview === "attention") {
    return (
      <Suspense fallback={null}>
        <AttentionPreview />
      </Suspense>
    );
  }
  if (WorktreePreview && preview === "worktree") {
    return (
      <Suspense fallback={null}>
        <WorktreePreview />
      </Suspense>
    );
  }
  return <WorkbenchApp />;
}

function WorkbenchApp() {
  const { ready, lastError, dialogOpen, clearError } = useAppShell();
  const errorText = userFacingMessage(lastError);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0f0f0f] text-sm text-[#666]">
        正在启动工作台…
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0f0f0f] text-[#e8e8e8]">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {errorText && !dialogOpen && (
          <div className="flex items-start gap-3 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200">
            <p className="min-w-0 flex-1">{errorText}</p>
            <button
              type="button"
              className="shrink-0 text-xs text-red-300 hover:text-white"
              onClick={clearError}
            >
              关闭
            </button>
          </div>
        )}
        <RightPane />
      </main>
      <NewProjectDialog />
      <UpdateDialog />
      <CommandMenuHost />
    </div>
  );
}
