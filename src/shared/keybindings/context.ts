// 从当前 DOM 焦点与共享壳状态构造 `WhenContext`。纯相对导入，支持在 Node 单测与浏览器中直接运行。

import { asElement, isEditableTarget } from "../dom/editable.ts";
import { isSidebarOpen } from "../shell/sidebar-open.ts";
import type { WhenContext } from "./types.ts";

export interface WhenContextOverrides {
  commandMenuOpen?: boolean;
  modalOpen?: boolean;
  sidebarOpen?: boolean;
  panelOpen?: boolean;
  settingsOpen?: boolean;
  boardOpen?: boolean;
  sessionActive?: boolean;
  projectActive?: boolean;
  isDesktop?: boolean;
  isWeb?: boolean;
  target?: EventTarget | null;
}

function detectDesktopRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function detectFocusContext(target?: EventTarget | null): Pick<
  WhenContext,
  "terminalFocus" | "composerFocus" | "inputFocus"
> {
  const active =
    target === null
      ? null
      : (asElement(target) ??
        (typeof document !== "undefined" ? asElement(document.activeElement) : null));
  if (!active) {
    return { terminalFocus: false, composerFocus: false, inputFocus: false };
  }
  const terminalFocus = Boolean(
    active.classList?.contains("xterm-helper-textarea") ||
      active.closest?.("[data-terminal-view], .xterm"),
  );
  const composerFocus = Boolean(active.closest?.(".composer-root") && isEditableTarget(active));
  const inputFocus =
    terminalFocus || composerFocus || isEditableTarget(active, { includeSelect: true });
  return { terminalFocus, composerFocus, inputFocus };
}

export function buildWhenContext(overrides: WhenContextOverrides = {}): WhenContext {
  const focus = detectFocusContext(overrides.target);
  const doc = typeof document !== "undefined" ? document : null;

  const commandMenuOpen =
    overrides.commandMenuOpen ?? Boolean(doc?.querySelector("[data-command-menu]"));

  const modalOpen =
    overrides.modalOpen ??
    Boolean(
      doc &&
        Array.from(doc.querySelectorAll("[data-file-search], [role='dialog'], [role='alertdialog']")).some(
          (el) => !el.closest("[data-command-menu]"),
        ),
    );

  const isDesktop = overrides.isDesktop ?? detectDesktopRuntime();
  const isWeb = overrides.isWeb ?? !isDesktop;

  return {
    ...focus,
    commandMenuOpen,
    modalOpen,
    sidebarOpen: overrides.sidebarOpen ?? isSidebarOpen(),
    panelOpen:
      overrides.panelOpen ??
      Boolean(
        doc?.querySelector(
          "[data-panel-layout='split'], [data-panel-layout='full'], [data-browser], [data-terminal-view]",
        ),
      ),
    settingsOpen: overrides.settingsOpen ?? false,
    boardOpen: overrides.boardOpen ?? false,
    sessionActive: overrides.sessionActive ?? false,
    projectActive: overrides.projectActive ?? false,
    isDesktop,
    isWeb,
  };
}
