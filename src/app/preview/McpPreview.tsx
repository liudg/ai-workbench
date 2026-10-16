import { useMemo, useState } from "react";

import type { AgentKind, McpAddSpec, McpServerRow } from "@/types";
import { McpPanel } from "@/features/workspace/settings/mcp/McpPanel";
import {
  claudeRows,
  codexRows,
  cursorRows,
  loginRow,
  previewSurfaces,
} from "@/features/workspace/settings/mcp/fixtures";

/** 开发预览。`?preview=mcp`，不启动第二个工作台窗口。 */
export default function McpPreview() {
  const params = new URLSearchParams(window.location.search);
  const initial = (params.get("agent") as AgentKind | null) ?? "codex-cli";
  const [selected, setSelected] = useState<AgentKind>(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const [toolsText, setToolsText] = useState<string | null>(null);
  const rows = useMemo(() => rowsFor(selected, params.get("login") === "1"), [selected, params]);

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-zinc-100">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <McpPanel
          surfaces={previewSurfaces}
          selected={selected}
          rows={rows}
          listError={null}
          busy={false}
          notice={notice}
          toolsText={toolsText}
          initialMode={params.get("form") === "new" ? "new" : "list"}
          onSelect={(kind) => {
            setNotice(null);
            setToolsText(null);
            setSelected(kind);
          }}
          onAdd={(spec: McpAddSpec) => setNotice(`preview add ${spec.name} ${spec.transport}`)}
          onRemove={(name) => setNotice(`preview remove ${name}`)}
          onLogin={(name, registration) => setNotice(`preview login ${name} ${registration}`)}
          onLogout={(name) => setNotice(`preview logout ${name}`)}
          onSetEnabled={(name, enabled) => setNotice(`preview ${enabled ? "enable" : "disable"} ${name}`)}
          onListTools={(name) => setToolsText(`tools for ${name}\n(no live call)`)}
        />
      </div>
    </div>
  );
}

function rowsFor(kind: AgentKind, login: boolean): McpServerRow[] {
  if (kind === "claude-code") return claudeRows;
  if (kind === "cursor-agent") return cursorRows;
  if (kind === "codex-cli") return login ? [...codexRows, loginRow] : codexRows;
  return [];
}
