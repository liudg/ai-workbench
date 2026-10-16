import { useState } from "react";

import { buildPaletteRows, type PaletteCaps, type PaletteSession } from "./commands";
import { CommandMenu, type PaletteDrill } from "./CommandMenu";

const sessions: PaletteSession[] = [
  { id: "s1", projectId: "p", title: "修登录跳转", archived: false, updatedAt: 5, pinned: true },
  { id: "s2", projectId: "p", title: "命令菜单", archived: false, updatedAt: 4, pinned: false },
  { id: "s3", projectId: "p", title: "", archived: false, updatedAt: 3, pinned: false },
  { id: "s4", projectId: "p", title: "整理差异", archived: false, updatedAt: 2, pinned: false },
];

const onCaps: PaletteCaps = {
  supports_archive: true,
  supports_rename: true,
  supports_delete: true,
  supports_fork: true,
  changes: { turn_diff: true, per_file_patch: true, git_scopes: true },
};

const offCaps: PaletteCaps = {
  supports_archive: false,
  supports_rename: false,
  supports_delete: false,
  supports_fork: false,
  changes: { turn_diff: false, per_file_patch: false, git_scopes: false },
};

/** 开发预览：`?preview=command-menu`。`caps=off` 关掉能力开关，`q` 预填搜索。 */
export default function CommandMenuPreview() {
  const params = new URLSearchParams(window.location.search);
  const caps = params.get("caps") === "off" ? offCaps : onCaps;
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [drill, setDrill] = useState<PaletteDrill>(params.get("drill") === "chats" ? "chats" : "commands");
  const [active, setActive] = useState(0);
  const rows = buildPaletteRows({
    query,
    mode: drill === "chats" ? "chats" : "commands",
    sessions,
    activeSessionId: "s1",
    caps,
    canNewThread: true,
    canStandalone: true,
    canSearchFiles: params.get("caps") !== "off",
  });
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
