import { useState } from "react";

import { buildPaletteRows, type PaletteRow, type PaletteSession } from "./commands";
import { CommandMenu, type PaletteDrill } from "./CommandMenu";
import { COMMAND_MENU_COPY as COPY } from "./copy";
import { fileRows } from "./file-rows";

const sessions: PaletteSession[] = [
  { id: "s1", projectId: "p", title: "修登录跳转", archived: false, updatedAt: 5, pinned: true },
  { id: "s2", projectId: "p", title: "命令菜单", archived: false, updatedAt: 4, pinned: false },
  { id: "s3", projectId: "p", title: "", archived: false, updatedAt: 3, pinned: false },
  { id: "s4", projectId: "p", title: "整理差异", archived: false, updatedAt: 2, pinned: false },
];

const onChanges = { turn_diff: true, per_file_patch: true, git_scopes: true };
const offChanges = { turn_diff: false, per_file_patch: false, git_scopes: false };

const PREVIEW_FILES = [
  "src/App.tsx",
  "src/features/sidebar/Sidebar.tsx",
  "docs/file-search.md",
  "README.md",
];

function previewDrill(value: string | null): PaletteDrill {
  if (value === "chats" || value === "files") return value;
  return "commands";
}

/** 开发预览：`?preview=command-menu`。`caps=off` 关掉变更能力，`q` 预填搜索，`drill=files` 看跳转文件。 */
export default function CommandMenuPreview() {
  const params = new URLSearchParams(window.location.search);
  const changes = params.get("caps") === "off" ? offChanges : onChanges;
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [drill, setDrill] = useState<PaletteDrill>(previewDrill(params.get("drill")));
  const [active, setActive] = useState(0);
  const noProject = params.get("project") === "off";
  const commandRows = buildPaletteRows({
    query,
    mode: drill === "chats" ? "chats" : "commands",
    sessions,
    activeSessionId: "s1",
    changes,
    canNewThread: true,
    canStandalone: true,
    canSearchFiles: params.get("caps") !== "off",
    canFind: params.get("find") !== "off",
  });
  const needle = query.trim().toLowerCase();
  const listed = PREVIEW_FILES.filter((path) => !needle || path.toLowerCase().includes(needle));
  const rows: readonly PaletteRow[] =
    drill === "files" ? (noProject ? [] : fileRows(listed)) : commandRows;
  const safeActive = rows.length === 0 ? 0 : Math.min(active, rows.length - 1);

  return (
    <div className="h-screen bg-[#0f0f0f] text-[#e8e8e8]" data-command-menu-preview>
      <CommandMenu
        query={query}
        rows={rows}
        active={safeActive}
        drill={drill}
        renameTitle=""
        renameError={null}
        deleteError={null}
        emptyText={drill === "files" && noProject ? COPY.noProject : undefined}
        onQuery={(value) => {
          setQuery(value);
          setActive(0);
        }}
        onActive={setActive}
        onRun={(index) => {
          const row = rows[index];
          if (row?.commandId === "search-chats") {
            setDrill("chats");
            setQuery("");
            setActive(0);
          }
          if (row?.commandId === "quick-open") {
            setDrill("files");
            setQuery("");
            setActive(0);
          }
        }}
        onClose={() => setDrill("commands")}
        onBack={() => {
          setDrill("commands");
          setQuery("");
          setActive(0);
        }}
        onRenameTitle={() => undefined}
        onRenameSubmit={() => undefined}
        onDeleteConfirm={() => undefined}
      />
    </div>
  );
}
