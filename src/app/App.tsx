import { useEffect } from "react";

import { NewProjectDialog, Sidebar } from "@/features/sidebar";
import { RightPane, UpdateDialog } from "@/features/workspace";
import { useWorkbench } from "@/store";
import { visibleBanner } from "@/store/sync";

export default function App() {
  const ready = useWorkbench((s) => s.ready);
  const init = useWorkbench((s) => s.init);
  const lastError = useWorkbench((s) => visibleBanner(s.lastError));
  const dialogOpen = useWorkbench((s) => s.dialog !== null);
  const clearError = useWorkbench((s) => s.clearError);

  useEffect(() => {
    init();
  }, [init]);

  if (!ready) {
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 text-sm text-zinc-600">
        正在启动工作台…
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-200">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        {lastError && !dialogOpen && (
          <div className="flex items-start gap-3 border-b border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200">
            <p className="min-w-0 flex-1">{lastError}</p>
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
    </div>
  );
}
