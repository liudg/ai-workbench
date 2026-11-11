import { useEffect, useState } from "react";

import type { AgentKind, McpAddSpec, McpPair, McpServerRow, McpSurface } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { McpForm } from "./McpForm";
import {
  MASKED_VALUE,
  MCP_PAGE,
  loginLaunch,
  menuActions,
  registrationAria,
  authMethodLabel,
  menuDismissKey,
  rowStatus,
  showAdd,
  showLoginScopes,
  showToggle,
  toggleNextAllowed,
  transportTag,
  uninstallConfirmBody,
  visibleUnavailableReason,
  type McpFeedback,
  type McpMenuId,
  type McpToolEntry,
} from "./view";

const inputClass =
  "w-full rounded-lg border border-[var(--wb-border-strong)] bg-[var(--wb-well)] px-3 py-2 text-sm text-[var(--wb-text-strong)] outline-none transition-colors placeholder:text-[var(--wb-muted)] focus:border-[var(--wb-accent)] focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/20 disabled:cursor-not-allowed disabled:opacity-50";

const STATUS_DOT: Record<string, string> = {
  connected: "bg-[var(--wb-success-strong)]",
  configured: "bg-[var(--wb-muted)]",
  loggedOut: "bg-[var(--wb-warn-strong)]",
  failed: "bg-[var(--wb-danger-strong)]",
  disabled: "bg-[var(--wb-faint)]",
};

export interface McpPanelProps {
  surfaces: McpSurface[];
  selected: AgentKind | null;
  rows: McpServerRow[];
  listError: string | null;
  listing?: boolean;
  rowBusy: ReadonlySet<string>;
  formBusy: boolean;
  feedback: McpFeedback | null;
  highlight: { name: string; token: number } | null;
  tools: Record<string, McpToolEntry[]>;
  initialMode?: "list" | "new";
  initialOpen?: string | null;
  initialAuth?: string | null;
  onSelect: (kind: AgentKind) => void;
  onAdd: (spec: McpAddSpec) => Promise<boolean> | boolean;
  onRemove: (name: string, scope: string) => void;
  onLogin: (name: string, registration: string, scopes: string) => void;
  onLogout: (name: string) => void;
  onSetEnabled: (name: string, enabled: boolean) => void;
  onListTools: (name: string) => void;
}

export function McpPanel(props: McpPanelProps) {
  const surface = props.surfaces.find((item) => item.kind === props.selected) ?? null;
  const [mode, setMode] = useState<"list" | "new" | "existing">(
    props.initialMode === "new" ? "new" : props.initialOpen ? "existing" : "list",
  );
  const [openName, setOpenName] = useState<string | null>(props.initialOpen ?? null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [authFor, setAuthFor] = useState<string | null>(props.initialAuth ?? null);
  const [confirmName, setConfirmName] = useState<string | null>(null);
  const [lit, setLit] = useState<string | null>(props.highlight?.name ?? null);
  const openRow = props.rows.find((row) => row.name === openName) ?? null;
  const confirmRow = props.rows.find((row) => row.name === confirmName) ?? null;

  useEffect(() => {
    if (props.initialOpen) setOpenName(props.initialOpen);
  }, [props.initialOpen]);

  useEffect(() => {
    setLit(props.highlight?.name ?? null);
    if (!props.highlight) return;
    const name = props.highlight.name;
    const timer = window.setTimeout(() => setLit(null), 4000);
    const frame = window.requestAnimationFrame(() => {
      const node = document.querySelector(`[data-mcp-highlight="${CSS.escape(name)}"]`);
      if (node instanceof HTMLElement) node.scrollIntoView({ block: "nearest" });
    });
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
    };
  }, [props.highlight]);

  useEffect(() => {
    if (mode === "existing" && openName && !props.rows.some((row) => row.name === openName)) {
      setMode("list");
      setOpenName(null);
    }
  }, [mode, openName, props.rows]);

  useEffect(() => {
    if (!menuFor) return;
    function onKey(event: KeyboardEvent) {
      if (!menuDismissKey(event.key)) return;
      event.preventDefault();
      setMenuFor(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuFor]);

  useEffect(() => {
    if (!menuFor && !authFor) return;
    function onDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-mcp-menu], [data-mcp-menu-trigger], [data-mcp-popover], [data-mcp-auth-trigger]")) return;
      setMenuFor(null);
      setAuthFor(null);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuFor, authFor]);

  function pick(kind: AgentKind) {
    setMode("list");
    setOpenName(null);
    setMenuFor(null);
    setAuthFor(null);
    setConfirmName(null);
    props.onSelect(kind);
  }

  function openDetail(name: string) {
    setMenuFor(null);
    setAuthFor(null);
    setOpenName(name);
    setMode("existing");
  }

  function runAction(id: McpMenuId, row: McpServerRow) {
    setMenuFor(null);
    if (id === "login") {
      if (surface && loginLaunch(surface, row) === "options") {
        setAuthFor(row.name);
        return;
      }
      props.onLogin(row.name, "", "");
      return;
    }
    if (id === "logout") {
      props.onLogout(row.name);
      return;
    }
    if (id === "tools") {
      setOpenName(row.name);
      setMode("existing");
      props.onListTools(row.name);
      return;
    }
    setConfirmName(row.name);
  }

  const reason = surface ? visibleUnavailableReason(surface.unavailable_reason) : null;
  const addOpen = Boolean(surface && mode === "new" && showAdd(surface));

  return (
    <section data-mcp-panel="">
      <h2 className="text-base font-medium text-[var(--wb-text-strong)]">{MCP_PAGE.nav}</h2>
      <p className="mt-1 max-w-lg text-sm leading-6 text-[var(--wb-muted)]">{MCP_PAGE.subtitle}</p>
      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label={MCP_PAGE.nav}>
        {props.surfaces.map((item) => {
          const selected = item.kind === surface?.kind;
          return (
            <button
              key={item.kind}
              type="button"
              role="tab"
              data-mcp-agent={item.kind}
              data-mcp-installed={item.installed ? "true" : "false"}
              aria-selected={selected}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35",
                selected &&
                  item.installed &&
                  "bg-[var(--wb-chip)] font-medium text-[var(--wb-text-strong)] shadow-2xs ring-1 ring-[var(--wb-border-strong)]",
                selected &&
                  !item.installed &&
                  "bg-[var(--wb-chip)] font-medium text-[var(--wb-muted)] ring-1 ring-[var(--wb-border-strong)]",
                !selected &&
                  item.installed &&
                  "text-[var(--wb-muted)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]",
                !selected &&
                  !item.installed &&
                  "text-[var(--wb-faint)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-muted)]",
              )}
              onClick={() => pick(item.kind)}
            >
              <span>{item.display_name}</span>
              {!item.installed && (
                <span className="text-xs text-[var(--wb-muted)]" data-mcp-uninstalled="">
                  {MCP_PAGE.notInstalled}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {props.feedback?.tone === "success" && (
        <p
          className="mt-4 inline-flex items-center rounded-full border border-[var(--wb-success-border)] bg-[var(--wb-success-bg)] px-3 py-1 text-xs font-medium text-[var(--wb-success-text)]"
          role="status"
          data-mcp-toast=""
        >
          {props.feedback.text}
        </p>
      )}
      {props.feedback?.tone === "failure" && <Failure title={props.feedback.title} detail={props.feedback.detail} />}
      {surface && addOpen && (
        <McpForm
          key={surface.kind}
          surface={surface}
          existingNames={props.rows.map((row) => row.name)}
          busy={props.formBusy}
          onBack={() => setMode("list")}
          onSave={async (spec) => {
            const ok = await props.onAdd(spec);
            if (ok) {
              setMode("list");
              setOpenName(null);
            }
            return ok;
          }}
        />
      )}
      {surface && mode === "existing" && openRow && (
        <ServerDetail
          surface={surface}
          row={openRow}
          busy={props.rowBusy.has(openRow.name)}
          tools={props.tools[openRow.name]}
          authOpen={authFor === openRow.name}
          onBack={() => {
            setMode("list");
            setOpenName(null);
            setAuthFor(null);
          }}
          onToggle={() => props.onSetEnabled(openRow.name, !openRow.enabled)}
          onAction={(id) => runAction(id, openRow)}
          onLogin={(registration, scopes) => {
            setAuthFor(null);
            props.onLogin(openRow.name, registration, scopes);
          }}
        />
      )}
      {surface && !addOpen && !(mode === "existing" && openRow) && (
        <ServerList
          key={surface.kind}
          surface={surface}
          rows={props.rows}
          listError={props.listError}
          listing={props.listing ?? false}
          reason={reason}
          rowBusy={props.rowBusy}
          lit={lit}
          menuFor={menuFor}
          authFor={authFor}
          onAdd={() => {
            setMenuFor(null);
            setAuthFor(null);
            setMode("new");
          }}
          onOpen={openDetail}
          onToggleMenu={(name) => {
            setAuthFor(null);
            setMenuFor((current) => (current === name ? null : name));
          }}
          onAction={runAction}
          onToggle={(row) => props.onSetEnabled(row.name, row.enabled === false)}
          onLogin={(name, registration, scopes) => {
            setAuthFor(null);
            props.onLogin(name, registration, scopes);
          }}
        />
      )}
      {confirmRow && (
        <Dialog open onOpenChange={(open) => !open && setConfirmName(null)}>
          <DialogContent data-mcp-confirm="">
            <DialogHeader>
              <DialogTitle>{MCP_PAGE.uninstallConfirmTitle}</DialogTitle>
              <DialogDescription>{uninstallConfirmBody(confirmRow.name)}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirmName(null)}>
                {MCP_PAGE.cancel}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                data-mcp-uninstall-confirm={confirmRow.name}
                disabled={props.rowBusy.has(confirmRow.name)}
                onClick={() => {
                  const name = confirmRow.name;
                  const scope = confirmRow.scope;
                  setConfirmName(null);
                  props.onRemove(name, scope);
                }}
              >
                {MCP_PAGE.uninstall}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}

function Failure({ title, detail }: { title: string; detail: string }) {
  const body = detail.trim();
  return (
    <div
      className="mt-4 rounded-xl border border-[var(--wb-danger-border)] bg-[var(--wb-danger-bg)] px-3.5 py-2.5"
      role="alert"
      data-mcp-error=""
    >
      <p className="text-sm font-medium text-[var(--wb-danger-text)]">{title}</p>
      {body && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-[var(--wb-muted)] hover:text-[var(--wb-text-strong)]">
            {MCP_PAGE.viewDetails}
          </summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg bg-[var(--wb-code-bg)] p-2.5 font-mono text-xs leading-5 text-[var(--wb-text)]">
            {body}
          </pre>
        </details>
      )}
    </div>
  );
}

function ServerList(props: {
  surface: McpSurface;
  rows: McpServerRow[];
  listError: string | null;
  listing: boolean;
  reason: string | null;
  rowBusy: ReadonlySet<string>;
  lit: string | null;
  menuFor: string | null;
  authFor: string | null;
  onAdd: () => void;
  onOpen: (name: string) => void;
  onToggleMenu: (name: string) => void;
  onAction: (id: McpMenuId, row: McpServerRow) => void;
  onToggle: (row: McpServerRow) => void;
  onLogin: (name: string, registration: string, scopes: string) => void;
}) {
  const { surface } = props;
  return (
    <div className="mt-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-[var(--wb-text-strong)]">{MCP_PAGE.heading}</h3>
        {showAdd(surface) && (
          <Button type="button" variant="outline" size="sm" data-mcp-add="" onClick={props.onAdd}>
            {MCP_PAGE.add}
          </Button>
        )}
      </div>
      {!surface.manageable && props.reason && (
        <p className="mt-4 text-sm leading-6 text-[var(--wb-muted)]" data-mcp-unavailable="">
          {props.reason}
        </p>
      )}
      {props.listError && <Failure title={MCP_PAGE.listErrorTitle} detail={props.listError} />}
      {surface.manageable && props.listing && props.rows.length === 0 && !props.listError && (
        <p className="mt-8 text-sm text-[var(--wb-muted)]" data-mcp-loading="">
          {MCP_PAGE.loading}
        </p>
      )}
      {surface.manageable && props.rows.length === 0 && !props.listError && !props.listing && (
        <p className="mt-8 text-sm text-[var(--wb-muted)]" data-mcp-empty="">
          {MCP_PAGE.empty}
        </p>
      )}
      <ul className="mt-4 space-y-2" data-mcp-list={surface.kind}>
        {props.rows.map((row) => {
          const busy = props.rowBusy.has(row.name);
          const actions = menuActions(surface, row);
          const tag = transportTag(row.transport);
          return (
            <li
              key={row.name}
              data-mcp-row={row.name}
              data-mcp-highlight={props.lit === row.name ? row.name : undefined}
              className={cn(
                "relative rounded-xl border px-4 py-3 transition-colors",
                props.lit === row.name
                  ? "border-[var(--wb-success-border)] bg-[var(--wb-success-bg)]"
                  : "border-[var(--wb-border)] bg-[var(--wb-card)] hover:border-[var(--wb-border-strong)]",
              )}
            >
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35"
                  data-mcp-open={row.name}
                  onClick={() => props.onOpen(row.name)}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-[var(--wb-text-strong)]">
                      {row.name}
                    </span>
                    {tag && (
                      <span
                        className="rounded border border-[var(--wb-border-strong)] bg-[var(--wb-chip)] px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-[var(--wb-muted)]"
                        data-mcp-transport-tag={tag}
                      >
                        {tag}
                      </span>
                    )}
                  </span>
                  <StatusLine row={row} busy={busy} />
                </button>
                {showToggle(surface, row) && (
                  <Toggle
                    name={row.name}
                    enabled={row.enabled === true}
                    disabled={busy || !toggleNextAllowed(surface, row.enabled === true)}
                    onToggle={() => props.onToggle(row)}
                  />
                )}
                {actions.length > 0 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-8 px-0"
                    data-mcp-menu-trigger={row.name}
                    aria-label={MCP_PAGE.more}
                    aria-haspopup="menu"
                    aria-expanded={props.menuFor === row.name}
                    disabled={busy}
                    onClick={() => props.onToggleMenu(row.name)}
                  >
                    ⋯
                  </Button>
                )}
              </div>
              {props.menuFor === row.name && (
                <div
                  role="menu"
                  aria-label={MCP_PAGE.more}
                  data-mcp-menu={row.name}
                  className="absolute right-3 top-14 z-10 w-44 overflow-hidden rounded-xl border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] p-1 shadow-[var(--wb-float-shadow)]"
                >
                  {actions.map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      role="menuitem"
                      className="block w-full rounded-lg px-2.5 py-1.5 text-left text-sm text-[var(--wb-text)] transition-colors hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text-strong)]"
                      data-mcp-action={action.id}
                      onClick={() => props.onAction(action.id, row)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
              {props.authFor === row.name && (
                <AuthPopover
                  surface={surface}
                  row={row}
                  busy={busy}
                  onLogin={(registration, scopes) => props.onLogin(row.name, registration, scopes)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StatusLine({ row, busy }: { row: McpServerRow; busy: boolean }) {
  const status = rowStatus(row);
  return (
    <span className="mt-1 flex items-center gap-2 text-xs text-[var(--wb-muted)]">
      <span className="inline-flex items-center gap-1.5" data-mcp-status={status.kind}>
        <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[status.kind])} aria-hidden />
        {status.label}
      </span>
      {busy && (
        <span data-mcp-busy={row.name} className="text-[var(--wb-muted)]">
          {MCP_PAGE.processing}
        </span>
      )}
    </span>
  );
}

function Toggle(props: { name: string; enabled: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <Switch
      data-mcp-toggle={props.name}
      checked={props.enabled}
      disabled={props.disabled}
      aria-label={props.enabled ? MCP_PAGE.disable : MCP_PAGE.enable}
      onCheckedChange={() => props.onToggle()}
    />
  );
}

function AuthPopover(props: {
  surface: McpSurface;
  row: McpServerRow;
  busy: boolean;
  onLogin: (registration: string, scopes: string) => void;
}) {
  const [registration, setRegistration] = useState(props.surface.oauth_registration[0]?.id ?? "");
  const [scopes, setScopes] = useState("");
  return (
    <div
      data-mcp-popover={props.row.name}
      className="mt-3 space-y-3 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-well)] p-3.5"
    >
      {props.surface.oauth_registration.length > 0 && (
        <label className="block text-xs text-[var(--wb-muted)]">
          {MCP_PAGE.registration}
          <select
            aria-label={registrationAria(registration)}
            className={inputClass + " mt-1"}
            value={registration}
            data-mcp-registration={props.row.name}
            onChange={(event) => setRegistration(event.target.value)}
          >
            {props.surface.oauth_registration.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {showLoginScopes(props.surface) && (
        <input
          className={inputClass}
          value={scopes}
          placeholder={MCP_PAGE.scopesPlaceholder}
          aria-label={MCP_PAGE.scopesPlaceholder}
          data-mcp-scopes={props.row.name}
          onChange={(event) => setScopes(event.target.value)}
        />
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.busy}
        data-mcp-login={props.row.name}
        onClick={() => props.onLogin(registration, scopes)}
      >
        {MCP_PAGE.authenticate}
      </Button>
    </div>
  );
}

function ToolList({ entries }: { entries: McpToolEntry[] }) {
  if (entries.length === 0) {
    return <p className="mt-3 text-xs text-[var(--wb-muted)]">{MCP_PAGE.toolsEmpty}</p>;
  }
  return (
    <ul className="mt-3 space-y-2" data-mcp-tool-list="">
      {entries.map((tool) => (
        <li
          key={tool.name}
          data-mcp-tool={tool.name}
          className="rounded-lg border border-[var(--wb-border)] bg-[var(--wb-card)] px-3 py-2"
        >
          <div className="font-mono text-xs font-medium text-[var(--wb-text-strong)]">
            {tool.name}
          </div>
          {tool.description && (
            <p className="mt-0.5 text-xs leading-5 text-[var(--wb-muted)]">{tool.description}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

function ServerDetail(props: {
  surface: McpSurface;
  row: McpServerRow;
  busy: boolean;
  tools: McpToolEntry[] | undefined;
  authOpen: boolean;
  onBack: () => void;
  onToggle: () => void;
  onAction: (id: McpMenuId) => void;
  onLogin: (registration: string, scopes: string) => void;
}) {
  const { surface, row } = props;
  const actions = menuActions(surface, row);
  const tag = transportTag(row.transport);
  const authMethod = authMethodLabel(row.auth_status);
  return (
    <div className="mt-6" data-mcp-form="existing">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-[var(--wb-text-strong)]" data-mcp-detail-title="">
          {row.name}
        </h3>
        <Button type="button" variant="outline" size="sm" onClick={props.onBack}>
          {MCP_PAGE.back}
        </Button>
      </div>
      <div className="mt-3">
        <StatusLine row={row} busy={props.busy} />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {showToggle(surface, row) && (
          <Toggle
            name={row.name}
            enabled={row.enabled === true}
            disabled={props.busy || !toggleNextAllowed(surface, row.enabled === true)}
            onToggle={props.onToggle}
          />
        )}
        {actions.map((action) => (
          <Button
            key={action.id}
            type="button"
            variant="outline"
            size="sm"
            data-mcp-auth-trigger={action.id === "login" ? row.name : undefined}
            data-mcp-action={action.id}
            disabled={props.busy}
            onClick={() => props.onAction(action.id)}
          >
            {action.label}
          </Button>
        ))}
      </div>
      {props.authOpen && (
        <AuthPopover surface={surface} row={row} busy={props.busy} onLogin={props.onLogin} />
      )}
      <dl className="mt-4 space-y-3 rounded-xl border border-[var(--wb-border)] bg-[var(--wb-card)] p-4 text-sm">
        <Readout label={MCP_PAGE.name} value={row.name} />
        {tag && <Readout label={MCP_PAGE.typeLabel} value={tag} />}
        {row.command && (
          <Readout
            label={MCP_PAGE.command}
            value={[row.command, ...row.args].filter(Boolean).join(" ")}
          />
        )}
        {row.url && <Readout label={MCP_PAGE.url} value={row.url} />}
        {row.bearer_token_env_var && (
          <Readout label={MCP_PAGE.bearer} value={row.bearer_token_env_var} />
        )}
        {row.cwd && <Readout label={MCP_PAGE.cwd} value={row.cwd} />}
        <SecretPairs label={MCP_PAGE.env} pairs={row.env} />
        {row.env_vars.length > 0 && (
          <Readout label={MCP_PAGE.envPassthrough} value={row.env_vars.join("\n")} />
        )}
        <SecretPairs label={MCP_PAGE.headers} pairs={row.headers} />
        {row.env_headers.length > 0 && (
          <Readout
            label={MCP_PAGE.envHeaders}
            value={row.env_headers.map((pair) => `${pair.key}=${pair.value}`).join("\n")}
          />
        )}
        {authMethod && (
          <div data-mcp-auth={authMethod}>
            <Readout label={MCP_PAGE.authLabel} value={authMethod} />
          </div>
        )}
      </dl>
      {props.tools && surface.verbs.list_tools && surface.tools_label.trim() && (
        <div className="mt-6" data-mcp-tools-for={row.name}>
          <h4 className="text-sm font-medium text-[var(--wb-text-strong)]">
            {MCP_PAGE.toolsHeading}
          </h4>
          <ToolList entries={props.tools} />
        </div>
      )}
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-[var(--wb-muted)]">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap text-[var(--wb-text-strong)]">{value}</dd>
    </div>
  );
}

function SecretPairs({ label, pairs }: { label: string; pairs: McpPair[] }) {
  const [open, setOpen] = useState<boolean[]>([]);
  if (pairs.length === 0) return null;
  return (
    <div data-mcp-secret-group={label}>
      <dt className="text-xs text-[var(--wb-muted)]">{label}</dt>
      <dd className="mt-1 space-y-1">
        {pairs.map((pair, index) => {
          const shown = open[index] === true;
          const hidden = pair.value.length > 0 && !shown;
          return (
            <div
              key={`${pair.key}-${index}`}
              className="flex flex-wrap items-center gap-2 text-[var(--wb-text-strong)]"
            >
              <span className="font-mono text-xs">{pair.key}</span>
              <span
                className="font-mono text-xs text-[var(--wb-text)]"
                data-mcp-secret-value={hidden ? "masked" : "shown"}
              >
                {hidden ? MASKED_VALUE : pair.value}
              </span>
              {pair.value.length > 0 && (
                <button
                  type="button"
                  className="text-xs text-[var(--wb-muted)] underline transition-colors hover:text-[var(--wb-text-strong)]"
                  aria-label={`${shown ? MCP_PAGE.hideValue : MCP_PAGE.showValue} ${pair.key}`}
                  onClick={() =>
                    setOpen((current) => {
                      const next = current.slice();
                      next[index] = !shown;
                      return next;
                    })
                  }
                >
                  {shown ? MCP_PAGE.hideValue : MCP_PAGE.showValue}
                </button>
              )}
            </div>
          );
        })}
      </dd>
    </div>
  );
}
