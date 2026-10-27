import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { X } from "lucide-react";

import { NewProjectDialog, Sidebar } from "@/features/sidebar";
import { UpdateDialog, useStartupUpdateCheck } from "@/features/updates";
import { Workspace } from "@/features/workspace";
import { clearError, useErrorBanner } from "@/shared/shell/error-banner";

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
      "plan-choice": lazy(() => import("@/app/preview/PlanChoicePreview")),
      questions: lazy(() => import("@/app/preview/QuestionPreview")),
      sidebar: lazy(() => import("@/features/sidebar/SidebarPreview")),
      "thread-find": lazy(() => import("@/app/preview/ThreadFindPreview")),
      usage: lazy(() => import("@/app/preview/UsagePreview")),
      "work-context": lazy(() => import("@/app/preview/WorkContextPreview")),
      worktree: lazy(() => import("@/app/preview/WorktreePreview")),
    }
  : null;

export default function App() {
  const name = new URLSearchParams(window.location.search).get("preview");
  const Preview = name ? PREVIEWS?.[name] : undefined;
  if (Preview) {
    return (
      <Suspense fallback={null}>
        <Preview />
      </Suspense>
    );
  }
  return <WorkbenchApp />;
}

function WorkbenchApp() {
  const error = useErrorBanner();
  useStartupUpdateCheck();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0f0f0f] text-[#e8e8e8]">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div className="flex items-start gap-3 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200">
            <p className="min-w-0 flex-1">{error}</p>
            <button
              type="button"
              aria-label="关闭"
              className="shrink-0 text-red-300 hover:text-white"
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
