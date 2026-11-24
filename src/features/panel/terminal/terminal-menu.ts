import type { ContextMenuItem } from "../../../shared/menu/ContextMenu.tsx";
import { relativeToProject } from "../../../shared/path.ts";
import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import type { TextSnippetDraft } from "../../../shared/text-snippet.ts";

export type TerminalContextLink =
  | {
      kind: "url";
      url: string;
    }
  | {
      kind: "file";
      resolvedPath: string;
      line: number | null;
    };

export interface TerminalContextMenuConfig {
  draft: TextSnippetDraft | null;
  selectedText: string;
  link: TerminalContextLink | null;
  projectPath: string;
  hasTerminal: boolean;
  exited: boolean;
  onAddToChat: (draft: TextSnippetDraft) => void;
  onOpenBuiltinUrl: (url: string) => void;
  onOpenExternalUrl: (url: string) => void;
  onOpenFile: (resolvedPath: string, line: number | null) => void;
  onCopyText: (text: string) => void;
  onClearSelection: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onClearTerminal: () => void;
}

const LABEL_OPEN_BUILTIN_BROWSER = "在内置浏览器打开";
const LABEL_OPEN_SYSTEM_BROWSER = "在系统浏览器打开";
const LABEL_COPY_LINK = "复制链接";
const LABEL_CLEAR_TERMINAL = "清屏";

/** 构造终端右键菜单项：选区发到对话、URL/已校验文件路径专属动作、复制粘贴、全选与清屏。 */
export function buildTerminalContextMenuItems(config: TerminalContextMenuConfig): ContextMenuItem[] {
  const {
    draft,
    selectedText,
    link,
    projectPath,
    hasTerminal,
    exited,
    onAddToChat,
    onOpenBuiltinUrl,
    onOpenExternalUrl,
    onOpenFile,
    onCopyText,
    onClearSelection,
    onPaste,
    onSelectAll,
    onClearTerminal,
  } = config;

  const items: ContextMenuItem[] = [
    {
      id: "add-to-chat",
      label: DESKTOP_ZH.addSelectionToChat,
      disabled: !draft,
      onSelect: () => {
        if (!draft) return;
        onAddToChat(draft);
        onClearSelection();
      },
    },
  ];

  if (link) {
    items.push({ id: "sep-link", separator: true });
    if (link.kind === "url") {
      items.push(
        {
          id: "open-url-builtin",
          label: LABEL_OPEN_BUILTIN_BROWSER,
          onSelect: () => onOpenBuiltinUrl(link.url),
        },
        {
          id: "open-url-external",
          label: LABEL_OPEN_SYSTEM_BROWSER,
          onSelect: () => onOpenExternalUrl(link.url),
        },
        {
          id: "copy-link",
          label: LABEL_COPY_LINK,
          onSelect: () => onCopyText(link.url),
        },
      );
    } else {
      const displayPath =
        (projectPath ? relativeToProject(link.resolvedPath, projectPath) : "") || link.resolvedPath;
      items.push(
        {
          id: "open-file",
          label: DESKTOP_ZH.openFiles,
          onSelect: () => onOpenFile(link.resolvedPath, link.line),
        },
        {
          id: "copy-path",
          label: DESKTOP_ZH.copyPath,
          onSelect: () => onCopyText(displayPath),
        },
      );
    }
  }

  const hasText = selectedText.length > 0;
  items.push(
    { id: "sep-clipboard", separator: true },
    {
      id: "copy",
      label: DESKTOP_ZH.menuCopy,
      disabled: !hasText,
      onSelect: () => {
        if (!hasText) return;
        onCopyText(selectedText);
        onClearSelection();
      },
    },
    {
      id: "paste",
      label: DESKTOP_ZH.menuPaste,
      disabled: !hasTerminal || exited,
      onSelect: onPaste,
    },
    { id: "sep-terminal", separator: true },
    {
      id: "select-all",
      label: DESKTOP_ZH.menuSelectAll,
      disabled: !hasTerminal,
      onSelect: onSelectAll,
    },
    {
      id: "clear",
      label: LABEL_CLEAR_TERMINAL,
      disabled: !hasTerminal,
      onSelect: onClearTerminal,
    },
  );

  return items;
}
