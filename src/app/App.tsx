import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { X } from "lucide-react";

import { useViewingReport } from "@/features/board";
import { NewProjectDialog, Sidebar } from "@/features/sidebar";
import { UpdateDialog, useStartupUpdateCheck } from "@/features/updates";
import { Workspace } from "@/features/workspace";
import { cn } from "@/lib/utils";
import { NativeMenuGuard } from "@/shared/menu/NativeMenuGuard";
import { clearError, useErrorBanner } from "@/shared/shell/error-banner";
import { useSidebarOpen } from "@/shared/shell/sidebar-open";

/** 开发样例页，`?preview=<名字>`。只在开发构建里有。 */
const PREVIEWS: Record<string, LazyExoticComponent<ComponentType>> | null = import.meta.env.DEV
  ? {
      activity: lazy(() => import("@/app/preview/ActivityPreview")),
      code: lazy(() => import("@/app/preview/CodePreview")),
      "command-menu": lazy(() => import("@/features/command-menu/CommandMenuPreview")),
      composer: lazy(() => import("@/features/chat/composer/ComposerPreview")),
      diff: lazy(() => import("@/app/preview/DiffPreview")),
      files: lazy(() => import("@/app/preview/FilesPreview")),
      "git-branch": lazy(() => import("@/app/preview/GitBranchPreview")),
      image: lazy(() => import("@/app/preview/ImagePanelPreview")),
      markdown: lazy(() => import("@/app/preview/MarkdownModePreview")),
      mcp: lazy(() => import("@/app/preview/McpPreview")),
      "nested-session": lazy(() => import("@/app/preview/NestedSessionPreview")),
      "plan-choice": lazy(() => import("@/app/preview/PlanChoicePreview")),
      questions: lazy(() => import("@/app/preview/QuestionPreview")),
      sidebar: lazy(() => import("@/features/sidebar/SidebarPreview")),
      subagents: lazy(() => import("@/app/preview/SubagentsPreview")),
      subtasks: lazy(() => import("@/app/preview/SubtasksPreview")),
      "thread-find": lazy(() => import("@/app/preview/ThreadFindPreview")),
      usage: lazy(() => import("@/app/preview/UsagePreview")),
      "work-context": lazy(() => import("@/app/preview/WorkContextPreview")),
      worktree: lazy(() => import("@/app/preview/WorktreePreview")),
    }
  : null;

export default function App() {
  const name = new URLSearchParams(window.location.search).get("preview");
  const Preview = name ? PREVIEWS?.[name] : undefined;
  return (
    <>
      {Preview ? (
        <Suspense fallback={null}>
          <Preview />
        </Suspense>
      ) : (
        <WorkbenchApp />
      )}
      <NativeMenuGuard />
    </>
  );
}

function WorkbenchApp() {
  const error = useErrorBanner();
  const sidebarOpen = useSidebarOpen();
  useStartupUpdateCheck();
  useViewingReport();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-wb-shell text-wb-fg">
      <Sidebar />
      <main
        className={cn(
          "my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-wb-border bg-wb-surface shadow-[var(--wb-island-shadow)]",
          !sidebarOpen && "ml-2",
        )}
      >
        {error && (
          <div className="flex items-start gap-3 border-b border-wb-danger/25 bg-wb-danger-soft px-4 py-2 text-[13px] text-wb-danger">
            <p className="min-w-0 flex-1">{error}</p>
            <button
              type="button"
              aria-label="关闭"
              className="shrink-0 rounded p-0.5 text-wb-danger/80 hover:bg-wb-hover hover:text-wb-danger"
              onClick={clearError}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <Workspace />
      </main>
      <NewProjectDialog />
      <UpdateDialog />
    </div>
  );
}
