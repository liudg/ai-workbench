import { useMemo, useState } from "react";

import type { AgentKind, McpAddSpec, McpServerRow } from "@/types";
import { McpPanel } from "@/features/settings/mcp/McpPanel";
import {
  claudeRows,
  codexRows,
  cursorRows,
  loginRow,
  previewSurfaces,
} from "@/features/settings/mcp/fixtures";
import { MCP_PAGE, type McpFeedback, type McpToolEntry } from "@/features/settings/mcp/view";

/** 开发预览。`?preview=mcp`，不启动第二个工作台窗口。 */
export default function McpPreview() {
  const params = new URLSearchParams(window.location.search);
  const initial = (params.get("agent") as AgentKind | null) ?? "codex-cli";
  const [selected, setSelected] = useState<AgentKind>(initial);
  const [feedback, setFeedback] = useState<McpFeedback | null>(null);
  const [highlight, setHighlight] = useState<{ name: string; token: number } | null>(null);
  const [tools, setTools] = useState<Record<string, McpToolEntry[]>>({});
  const rows = useMemo(() => rowsFor(selected, params.get("login") === "1"), [selected, params]);

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-zinc-100">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <McpPanel
          surfaces={previewSurfaces}
          selected={selected}
          rows={rows}
          listError={null}
          rowBusy={new Set<string>()}
          formBusy={false}
          feedback={feedback}
          highlight={highlight}
          tools={tools}
          initialMode={params.get("form") === "new" ? "new" : "list"}
          onSelect={(kind) => {
            setFeedback(null);
            setHighlight(null);
            setTools({});
            setSelected(kind);
          }}
          onRefresh={() => setFeedback(null)}
          onAdd={(spec: McpAddSpec) => {
            setFeedback({ tone: "success", text: MCP_PAGE.saved });
            setHighlight({ name: spec.name, token: Date.now() });
            return true;
          }}
          onRemove={(name) => setFeedback({ tone: "success", text: `${MCP_PAGE.removed} ${name}` })}
          onLogin={(name) => setFeedback({ tone: "success", text: `${MCP_PAGE.authStarted} ${name}` })}
          onLogout={(name) => setFeedback({ tone: "success", text: `${MCP_PAGE.authCleared} ${name}` })}
          onSetEnabled={(name, enabled) =>
            setFeedback({ tone: "success", text: `${enabled ? MCP_PAGE.enabled : MCP_PAGE.disabled} ${name}` })
          }
          onListTools={(name) =>
            setTools((current) => ({
              ...current,
              [name]: [{ name: "echo", description: "把文字原样返回" }],
            }))
          }
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
