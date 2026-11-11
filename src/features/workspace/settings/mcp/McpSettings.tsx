import { McpPanel } from "./McpPanel";
import { useMcpSettings } from "./useMcpSettings";
import { MCP_PAGE } from "./view";

export function McpSettings() {
  const state = useMcpSettings();

  if (state.surfaces === null) {
    return <p className="text-sm text-[var(--wb-muted)]">{MCP_PAGE.loading}</p>;
  }

  return (
    <McpPanel
      surfaces={state.surfaces}
      selected={state.selected}
      rows={state.rows}
      listError={state.listError}
      listing={state.listing}
      rowBusy={state.rowBusy}
      formBusy={state.formBusy}
      feedback={state.feedback}
      highlight={state.highlight}
      tools={state.tools}
      onSelect={state.onSelect}
      onAdd={state.onAdd}
      onRemove={state.onRemove}
      onLogin={state.onLogin}
      onLogout={state.onLogout}
      onSetEnabled={state.onSetEnabled}
      onListTools={state.onListTools}
    />
  );
}
