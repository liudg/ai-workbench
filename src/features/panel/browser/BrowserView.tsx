import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { BrowserChrome } from "./BrowserChrome";
import { NewTabPage } from "./NewTabPage";
import { currentEntry } from "./browser";
import { useBrowserSession } from "./useBrowserSession";

export function BrowserView({
  tabId,
  projectId,
  sessionId,
  path,
  initialUrl,
  text,
  onTitle,
}: {
  tabId: string;
  projectId: string;
  sessionId: string;
  path: string;
  initialUrl?: string;
  text: string;
  onTitle: (title: string) => void;
}) {
  const session = useBrowserSession({
    tabId,
    projectId,
    sessionId,
    path,
    initialUrl,
    text,
    onTitle,
  });

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--wb-diff-well)]" data-browser>
      <BrowserChrome
        shown={session.shown}
        draft={session.draft}
        annotating={session.annotating}
        canBack={session.canBack}
        canForward={session.canForward}
        frameTarget={session.frameTarget}
        showAnnotate={session.showAnnotate}
        onDraft={session.setDraft}
        onFocusAddress={() => session.setDraft(currentEntry(session.history)?.address ?? session.shown)}
        onBlurAddress={() => session.setDraft(null)}
        onSubmit={session.submit}
        onBack={() => session.go("back")}
        onForward={() => session.go("forward")}
        onReload={session.reload}
        onAnnotate={session.toggleAnnotate}
      />
      {session.error ? (
        <p className="shrink-0 border-b border-[var(--wb-danger-border)] bg-[var(--wb-danger-bg)] px-3 py-1 text-xs text-[var(--wb-danger-text)]">
          {session.error}
        </p>
      ) : null}
      {session.snapshotFailed ? (
        <p className="shrink-0 border-b border-[var(--wb-warn-border)] bg-[var(--wb-warn-bg)] px-3 py-1 text-[11px] text-[var(--wb-warn-text)]">
          {DESKTOP_ZH.browserSnapshotFailed}
        </p>
      ) : null}
      <div
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--wb-diff-well)]",
          Boolean(session.frameTarget) && "px-1.5 pb-1.5 pt-1",
        )}
      >
        <div
          ref={session.viewport}
          className={cn(
            "relative min-h-0 min-w-0 flex-1 overflow-hidden bg-[var(--wb-diff-well)]",
            Boolean(session.frameTarget) && "rounded-lg border border-[var(--wb-border)]",
          )}
          data-browser-viewport
        >
          {!session.frameTarget ? <NewTabPage /> : null}
          {!session.native && session.frameTarget ? (
            <iframe
              title={session.shown || DESKTOP_ZH.browserNewTab}
              sandbox="allow-scripts allow-forms allow-popups allow-modals"
              src={session.localFrame ? undefined : session.frameTarget}
              srcDoc={session.localFrame ? session.text || undefined : undefined}
              key={session.frameKey}
              className="h-full w-full border-0 bg-white [color-scheme:light]"
              data-browser-frame="iframe"
              onLoad={session.onFrameLoad}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
