import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useViewingReport } from "@/features/board";
import { NewProjectDialog, Sidebar } from "@/features/sidebar";
import {
  UpdateDialog,
  UpdateTitlebarPill,
  useStartupUpdateCheck,
} from "@/features/updates";
import { Workspace } from "@/features/workspace";
import { formatHiddenCharactersWarning } from "@/lib/native/prompt-link";
import { cn } from "@/lib/utils";
import { NativeMenuGuard } from "@/shared/menu/NativeMenuGuard";
import { clearError, useErrorBanner } from "@/shared/shell/error-banner";
import { useSidebarOpen } from "@/shared/shell/sidebar-open";
import { useWindowTitlebar } from "./use-window-titlebar";
import { useLaunchIntent } from "./useLaunchIntent";
import { WindowTitlebar } from "./WindowTitlebar";

/** 开发样例页，`?preview=<名字>`。只在开发构建里有。 */
const PREVIEWS: Record<string, LazyExoticComponent<ComponentType>> | null = import.meta.env.DEV
  ? {
      activity: lazy(() => import("@/app/preview/ActivityPreview")),
      "background-tasks": lazy(() => import("@/app/preview/BackgroundTasksPreview")),
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
  const titlebar = useWindowTitlebar();
  const launch = useLaunchIntent();
  useStartupUpdateCheck();
  useViewingReport();

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-wb-shell text-wb-fg">
      <WindowTitlebar
        chrome={titlebar}
        trailing={titlebar.nativeControls ? <UpdateTitlebarPill /> : undefined}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <main
          className={cn(
            "mb-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-wb-border bg-wb-surface shadow-[var(--wb-island-shadow)]",
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
          {launch.warning && (
            <div
              role="status"
              data-launch-prompt-warning=""
              className="flex items-start gap-3 border-b border-wb-warn/25 bg-wb-warn-soft px-4 py-2 text-[13px] text-wb-warn"
            >
              <p className="min-w-0 flex-1">{launch.warning}</p>
              <button
                type="button"
                aria-label="关闭提示"
                className="shrink-0 rounded p-0.5 text-wb-warn/80 hover:bg-wb-hover hover:text-wb-warn"
                onClick={launch.dismissWarning}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          <Workspace />
        </main>
      </div>
      <NewProjectDialog />
      <UpdateDialog />
      <Dialog
        open={launch.overwritePrompt !== null}
        onOpenChange={(open) => {
          if (!open) launch.cancelOverwrite();
        }}
      >
        <DialogContent data-launch-overwrite-dialog="">
          <DialogHeader>
            <DialogTitle>替换未发送的草稿？</DialogTitle>
            <DialogDescription>
              当前输入框已有未发送的内容，确认后将用外部传入的提示词替换原草稿（不会自动发送）。
            </DialogDescription>
          </DialogHeader>
          {launch.overwritePrompt && launch.overwritePrompt.hiddenCharactersRemoved > 0 && (
            <p
              role="alert"
              className="rounded-lg border border-wb-warn/25 bg-wb-warn-soft px-3 py-2 text-xs leading-5 text-wb-warn"
            >
              {formatHiddenCharactersWarning(
                launch.overwritePrompt.hiddenCharactersRemoved,
                launch.overwritePrompt.truncated,
              )}
            </p>
          )}
          {launch.overwritePrompt && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-wb-border bg-wb-code p-3 text-xs leading-5 text-wb-fg-2">
              {launch.overwritePrompt.incomingPrompt}
            </pre>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" autoFocus onClick={launch.cancelOverwrite}>
              保留原草稿
            </Button>
            <Button type="button" onClick={launch.confirmOverwrite}>
              替换草稿
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
