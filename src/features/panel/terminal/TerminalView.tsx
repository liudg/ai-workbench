import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import type { Terminal } from "@xterm/xterm";

import { openUrl } from "@/lib/native/open-path";
import { writeClipboardText } from "@/shared/clipboard";
import { ContextMenu } from "@/shared/menu/ContextMenu";
import { FloatingSelectionBar } from "@/shared/selection/SelectionMenu";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { TextSnippetDraft } from "@/shared/text-snippet";
import { usePanel } from "../core/PanelProvider";
import type { ViewerViewProps } from "../core/registry";
import { findTerminalLinkAt, terminalCellFromPoint } from "./terminal-links";
import { buildTerminalContextMenuItems, type TerminalContextLink } from "./terminal-menu";
import { terminalSelectionDraft, terminalSelectionFallbackPoint } from "./terminal-selection";
import { useTerminal, type TerminalPayload } from "./useTerminal";

interface ContextMenuState {
  seq: number;
  x: number;
  y: number;
  draft: TextSnippetDraft | null;
  selectedText: string;
  link: TerminalContextLink | null;
}

export function TerminalView({ tabId, payload, sessionId }: ViewerViewProps<TerminalPayload>) {
  const { patchTabPayload, data, openHref, projectPath } = usePanel();
  const rootRef = useRef<HTMLDivElement>(null);
  const suppressKeysRef = useRef(false);
  const menuSeqRef = useRef(0);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  suppressKeysRef.current = contextMenu !== null;

  const patchPayload = useCallback(
    (patch: Partial<TerminalPayload>) => patchTabPayload(tabId, patch),
    [patchTabPayload, tabId],
  );
  const openExternalUrl = useCallback((url: string) => {
    void openUrl(url).catch(() => {});
  }, []);

  const { hostRef, term, verifier, exited, exitCode, error, restart } = useTerminal({
    tabId,
    sessionId,
    terminalId: payload?.terminalId,
    open: data.openTerminal,
    patchPayload,
    resolveFile: data.resolveFile,
    openHref,
    openExternalUrl,
    suppressKeysRef,
  });

  const terminalTitle = payload?.title?.trim() || DESKTOP_ZH.terminal;

  const addSnippetToChat = useCallback(
    (draft: TextSnippetDraft) => {
      data.addTextSnippet(sessionId, draft);
    },
    [data, sessionId],
  );

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const seq = menuSeqRef.current + 1;
      menuSeqRef.current = seq;

      const keyboardTrigger = event.button === 0 && event.clientX === 0 && event.clientY === 0;
      const hostRect = hostRef.current?.getBoundingClientRect();
      const x = keyboardTrigger ? Math.round((hostRect?.left ?? 16) + 24) : event.clientX;
      const y = keyboardTrigger ? Math.round((hostRect?.top ?? 16) + 24) : event.clientY;

      const draft = terminalSelectionDraft(term, terminalTitle);
      const selectedText = term?.hasSelection() ? term.getSelection() : "";

      let initialLink: TerminalContextLink | null = null;
      if (term && !keyboardTrigger) {
        const cell = terminalCellFromPoint(term, event.clientX, event.clientY);
        const hit = cell
          ? findTerminalLinkAt(term.buffer.active, term.cols, cell.bufferLineNumber, cell.col)
          : null;
        if (hit?.kind === "url") {
          initialLink = { kind: "url", url: hit.url };
        } else if (hit?.kind === "file") {
          const cached = verifier.peek(hit.path);
          if (cached.known) {
            if (cached.resolved) {
              initialLink = { kind: "file", resolvedPath: cached.resolved, line: hit.line };
            }
          } else {
            void verifier.verifyNow(hit.path).then((resolved) => {
              if (!resolved || menuSeqRef.current !== seq) return;
              setContextMenu((current) =>
                current && current.seq === seq
                  ? { ...current, link: { kind: "file", resolvedPath: resolved, line: hit.line } }
                  : current,
              );
            });
          }
        }
      }

      setContextMenu({
        seq,
        x,
        y,
        draft,
        selectedText,
        link: initialLink,
      });
    },
    [hostRef, term, terminalTitle, verifier],
  );

  const closeContextMenu = useCallback(() => {
    menuSeqRef.current += 1;
    setContextMenu(null);
  }, []);

  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return [];
    return buildTerminalContextMenuItems({
      draft: contextMenu.draft,
      selectedText: contextMenu.selectedText,
      link: contextMenu.link,
      projectPath,
      hasTerminal: Boolean(term),
      exited,
      onAddToChat: addSnippetToChat,
      onOpenBuiltinUrl: (url) => openHref(url),
      onOpenExternalUrl: openExternalUrl,
      onOpenFile: (resolvedPath, line) => openHref(resolvedPath, line ?? undefined),
      onCopyText: (text) => {
        void writeClipboardText(text).catch(() => {});
      },
      onClearSelection: () => {
        term?.clearSelection();
        term?.focus();
      },
      onPaste: () => {
        if (!term || exited) return;
        void navigator.clipboard
          ?.readText()
          .then((text) => {
            if (text) {
              term.focus();
              term.paste(text);
            }
          })
          .catch(() => {});
      },
      onSelectAll: () => {
        term?.focus();
        term?.selectAll();
      },
      onClearTerminal: () => {
        term?.focus();
        term?.clear();
      },
    });
  }, [addSnippetToChat, contextMenu, exited, openExternalUrl, openHref, projectPath, term]);

  const notice = error ?? (exited ? exitNotice(exitCode) : null);
  return (
    <div
      ref={rootRef}
      data-terminal-view
      onContextMenu={handleContextMenu}
      className="flex h-full flex-col bg-wb-panel text-wb-fg"
    >
      <div ref={hostRef} className="min-h-0 flex-1 bg-wb-panel py-2 pl-3 pr-2 text-wb-fg" />
      {notice ? (
        <div
          className={`flex shrink-0 items-center gap-3 border-t border-wb-border px-3 py-2 text-xs ${
            error ? "text-wb-danger" : "text-wb-fg-2"
          }`}
        >
          <span className="min-w-0 flex-1 truncate">{notice}</span>
          <button
            type="button"
            className="shrink-0 rounded-lg border border-wb-border bg-wb-elev px-2.5 py-1 text-wb-fg hover:bg-wb-hover"
            onClick={restart}
          >
            {DESKTOP_ZH.terminalRestart}
          </button>
        </div>
      ) : null}
      <TerminalSelectionBar
        rootRef={rootRef}
        term={term}
        title={terminalTitle}
        suppressed={contextMenu !== null}
        onAddToChat={addSnippetToChat}
      />
      {contextMenu ? (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={closeContextMenu}
        />
      ) : null}
    </div>
  );
}

export function TerminalSelectionBar({
  rootRef,
  term,
  title,
  suppressed,
  onAddToChat,
}: {
  rootRef: RefObject<HTMLElement | null>;
  term: Terminal | null;
  title: string;
  suppressed: boolean;
  onAddToChat: (draft: TextSnippetDraft) => void;
}) {
  return (
    <FloatingSelectionBar
      rootRef={rootRef}
      sourceKey={term}
      enabled={Boolean(term)}
      suppressed={suppressed}
      watchWheel
      isTargetInside={(root, target) =>
        Boolean(target instanceof Element && root.contains(target) && target.closest(".xterm-screen"))
      }
      readSelection={() => {
        if (!term) return null;
        const draft = terminalSelectionDraft(term, title);
        return draft
          ? { draft, fallbackPoint: () => terminalSelectionFallbackPoint(term) }
          : null;
      }}
      subscribeSource={({ onChange, onClear, onScroll }) => {
        if (!term) return () => {};
        const stopSelection = term.onSelectionChange(() => {
          if (!term.hasSelection()) onClear();
          else onChange();
        });
        const stopTermScroll = term.onScroll(onScroll);
        return () => {
          stopSelection.dispose();
          stopTermScroll.dispose();
        };
      }}
      items={() => [
        {
          id: "add",
          label: DESKTOP_ZH.addSelectionToChat,
          onClick: (draft, dismiss) => {
            dismiss();
            term?.clearSelection();
            onAddToChat(draft);
            term?.focus();
          },
        },
        {
          id: "copy",
          label: DESKTOP_ZH.menuCopy,
          onClick: (draft, dismiss) => {
            const text = (term?.hasSelection() ? term.getSelection() : "") || draft.body;
            dismiss();
            term?.clearSelection();
            void writeClipboardText(text).catch(() => {});
            term?.focus();
          },
        },
      ]}
    />
  );
}

function exitNotice(code: number | null): string {
  return code == null ? DESKTOP_ZH.terminalExited : DESKTOP_ZH.terminalExitedWithCode.replace("{code}", String(code));
}
