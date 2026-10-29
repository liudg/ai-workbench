import { useEffect, useState } from "react";

import type { AgentKind, McpAddSpec, McpPair, McpServerRow, McpSurface } from "@/types";
import { McpForm } from "./McpForm";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
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
  statusIssue,
  toggleNextAllowed,
  transportTag,
  uninstallConfirmBody,
  visibleUnavailableReason,
  type McpFeedback,
  type McpMenuId,
  type McpToolEntry,
} from "./view";

const inputClass =
  "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500";
const quietButton =
  "rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 hover:bg-zinc-800 disabled:opacity-50";

const STATUS_DOT: Record<string, string> = {
  connected: "bg-emerald-400",
  configured: "bg-zinc-400",
  loggedOut: "bg-amber-400",
  failed: "bg-red-400",
  disabled: "bg-zinc-500",
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
  onRefresh: () => void;
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
        setAuthFor((current) => (current === row.name ? null : row.name));
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
      <h2 className="text-base font-medium text-zinc-100">{MCP_PAGE.nav}</h2>
      <p className="mt-1 max-w-lg text-sm leading-6 text-zinc-500">{MCP_PAGE.subtitle}</p>
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
                "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm",
                !item.installed && "text-zinc-600",
                selected && item.installed && "bg-zinc-800 text-zinc-50",
                selected && !item.installed && "bg-zinc-900 text-zinc-500",
                !selected && item.installed && "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-100",
                !selected && !item.installed && "hover:bg-zinc-800/30",
              )}
              onClick={() => pick(item.kind)}
            >
              <span>{item.display_name}</span>
              {!item.installed && (
                <span className="text-xs text-zinc-500" data-mcp-uninstalled="">
                  {MCP_PAGE.notInstalled}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {props.feedback?.tone === "success" && (
        <p
          className="mt-4 inline-flex rounded-full bg-zinc-800 px-3 py-1 text-sm text-zinc-100"
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
          onRefresh={props.onRefresh}
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
              <button type="button" className={quietButton} onClick={() => setConfirmName(null)}>
                {MCP_PAGE.cancel}
              </button>
              <button
                type="button"
                className={quietButton + " border-red-900 text-red-300"}
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
              </button>
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
    <div className="mt-4 rounded-lg border border-red-900/80 bg-red-950/40 px-3 py-2" role="alert" data-mcp-error="">
      <p className="text-sm text-red-200">{title}</p>
      {body && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-zinc-400">{MCP_PAGE.viewDetails}</summary>
          <pre className="mt-2 whitespace-pre-wrap text-xs leading-5 text-zinc-400">{body}</pre>
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
  onRefresh: () => void;
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
        <h3 className="flex items-center gap-2 text-sm font-medium text-zinc-100">
          {MCP_PAGE.heading}
          {props.listing && props.rows.length > 0 && (
            <span className="text-xs font-normal text-zinc-500" role="status" data-mcp-refreshing="">
              {MCP_PAGE.refreshing}
            </span>
          )}
        </h3>
        <div className="flex gap-2">
          {surface.manageable && surface.verbs.list && (
            <button
              type="button"
              data-mcp-refresh=""
              className={quietButton}
              disabled={props.listing}
              onClick={props.onRefresh}
            >
              {MCP_PAGE.refresh}
            </button>
          )}
          {showAdd(surface) && (
            <button type="button" data-mcp-add="" className={quietButton} onClick={props.onAdd}>
              {MCP_PAGE.add}
            </button>
          )}
        </div>
      </div>
      {!surface.manageable && props.reason && (
        <p className="mt-4 text-sm leading-6 text-zinc-400" data-mcp-unavailable="">
          {props.reason}
        </p>
      )}
      {props.listError && <Failure title={MCP_PAGE.listErrorTitle} detail={props.listError} />}
      {surface.manageable && props.listing && props.rows.length === 0 && !props.listError && (
        <p className="mt-8 text-sm text-zinc-500" data-mcp-loading="">
          {MCP_PAGE.loading}
        </p>
      )}
      {surface.manageable && props.rows.length === 0 && !props.listError && !props.listing && (
        <p className="mt-8 text-sm text-zinc-500" data-mcp-empty="">
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
                "relative rounded-xl border bg-zinc-900/60 px-4 py-3",
                props.lit === row.name ? "border-emerald-500/80 bg-emerald-950/30" : "border-zinc-800",
              )}
            >
              <div className="flex items-center gap-3">
                <button type="button" className="min-w-0 flex-1 text-left" data-mcp-open={row.name} onClick={() => props.onOpen(row.name)}>
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-zinc-100">{row.name}</span>
                    {tag && (
                      <span
                        className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] tracking-wide text-zinc-400"
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
                  <button
                    type="button"
                    className={quietButton + " px-2"}
                    data-mcp-menu-trigger={row.name}
                    aria-label={MCP_PAGE.more}
                    aria-haspopup="menu"
                    aria-expanded={props.menuFor === row.name}
                    disabled={busy}
                    onClick={() => props.onToggleMenu(row.name)}
                  >
                    ⋯
                  </button>
                )}
              </div>
              {props.menuFor === row.name && (
                <div
                  role="menu"
                  aria-label={MCP_PAGE.more}
                  data-mcp-menu={row.name}
                  className="absolute right-3 top-14 z-10 w-44 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
                >
                  {actions.map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      role="menuitem"
                      className="block w-full px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800"
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

/** 列表行带上一行原因；详情页另有完整的「问题」，这里不重复。 */
function StatusLine({ row, busy, brief = true }: { row: McpServerRow; busy: boolean; brief?: boolean }) {
  const status = rowStatus(row);
  const issue = brief ? statusIssue(row) : null;
  return (
    <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-zinc-400">
      <span className="inline-flex shrink-0 items-center gap-1.5" data-mcp-status={status.kind}>
        <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[status.kind])} aria-hidden />
        {status.label}
      </span>
      {issue && (
        <span className="min-w-0 truncate text-zinc-500" title={issue} data-mcp-issue="">
          {issue}
        </span>
      )}
      {busy && (
        <span data-mcp-busy={row.name} className="text-zinc-500">
          {MCP_PAGE.processing}
        </span>
      )}
    </span>
  );
}

function Toggle(props: { name: string; enabled: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      data-mcp-toggle={props.name}
      aria-checked={props.enabled}
      aria-label={props.enabled ? MCP_PAGE.disable : MCP_PAGE.enable}
      disabled={props.disabled}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50",
        props.enabled ? "bg-emerald-500" : "bg-zinc-700",
      )}
      onClick={props.onToggle}
    >
      <span
        className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white", props.enabled ? "left-4" : "left-0.5")}
        aria-hidden
      />
    </button>
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
      className="mt-3 space-y-3 rounded-lg border border-zinc-700 bg-zinc-950 p-3"
    >
      {props.surface.oauth_registration.length > 0 && (
        <label className="block text-xs text-zinc-400">
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
      <button
        type="button"
        className={quietButton}
        disabled={props.busy}
        data-mcp-login={props.row.name}
        onClick={() => props.onLogin(registration, scopes)}
      >
        {MCP_PAGE.authenticate}
      </button>
    </div>
  );
}

function ToolList({ entries }: { entries: McpToolEntry[] }) {
  if (entries.length === 0) {
    return <p className="mt-3 text-xs text-zinc-500">{MCP_PAGE.toolsEmpty}</p>;
  }
  return (
    <ul className="mt-3 space-y-2" data-mcp-tool-list="">
      {entries.map((tool) => (
        <li key={tool.name} data-mcp-tool={tool.name}>
          <div className="text-sm text-zinc-100">{tool.name}</div>
          {tool.description && <p className="text-xs leading-5 text-zinc-500">{tool.description}</p>}
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
  const issue = statusIssue(row);
  return (
    <div className="mt-6" data-mcp-form="existing">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-zinc-100" data-mcp-detail-title="">
          {row.name}
        </h3>
        <button type="button" className={quietButton} onClick={props.onBack}>
          {MCP_PAGE.back}
        </button>
      </div>
      <div className="mt-3">
        <StatusLine row={row} busy={props.busy} brief={false} />
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
          <button
            key={action.id}
            type="button"
            className={quietButton}
            data-mcp-auth-trigger={action.id === "login" ? row.name : undefined}
            data-mcp-action={action.id}
            disabled={props.busy}
            onClick={() => props.onAction(action.id)}
          >
            {action.label}
          </button>
        ))}
      </div>
      {props.authOpen && (
        <AuthPopover surface={surface} row={row} busy={props.busy} onLogin={props.onLogin} />
      )}
      <dl className="mt-4 space-y-3 text-sm">
        <Readout label={MCP_PAGE.name} value={row.name} />
        {tag && <Readout label={MCP_PAGE.typeLabel} value={tag} />}
        {row.command && <Readout label={MCP_PAGE.command} value={[row.command, ...row.args].filter(Boolean).join(" ")} />}
        {row.url && <Readout label={MCP_PAGE.url} value={row.url} />}
        {row.bearer_token_env_var && <Readout label={MCP_PAGE.bearer} value={row.bearer_token_env_var} />}
        {row.cwd && <Readout label={MCP_PAGE.cwd} value={row.cwd} />}
        <SecretPairs label={MCP_PAGE.env} pairs={row.env} />
        {row.env_vars.length > 0 && <Readout label={MCP_PAGE.envPassthrough} value={row.env_vars.join("\n")} />}
        <SecretPairs label={MCP_PAGE.headers} pairs={row.headers} />
        {row.env_headers.length > 0 && (
          <Readout label={MCP_PAGE.envHeaders} value={row.env_headers.map((pair) => `${pair.key}=${pair.value}`).join("\n")} />
        )}
        {issue && <Readout label={MCP_PAGE.issue} value={issue} />}
        {authMethod && (
          <div data-mcp-auth={authMethod}>
            <Readout label={MCP_PAGE.authLabel} value={authMethod} />
          </div>
        )}
      </dl>
      {props.tools && surface.verbs.list_tools && surface.tools_label.trim() && (
        <div className="mt-6" data-mcp-tools-for={row.name}>
          <h4 className="text-sm font-medium text-zinc-100">{MCP_PAGE.toolsHeading}</h4>
          <ToolList entries={props.tools} />
        </div>
      )}
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap break-all text-zinc-100">{value}</dd>
    </div>
  );
}

function SecretPairs({ label, pairs }: { label: string; pairs: McpPair[] }) {
  const [open, setOpen] = useState<boolean[]>([]);
  if (pairs.length === 0) return null;
  return (
    <div data-mcp-secret-group={label}>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-1 space-y-1">
        {pairs.map((pair, index) => {
          const shown = open[index] === true;
          const hidden = pair.value.length > 0 && !shown;
          return (
            <div key={`${pair.key}-${index}`} className="flex flex-wrap items-center gap-2 text-zinc-100">
              <span className="font-mono text-xs">{pair.key}</span>
              <span className="font-mono text-xs" data-mcp-secret-value={hidden ? "masked" : "shown"}>
                {hidden ? MASKED_VALUE : pair.value}
              </span>
              {pair.value.length > 0 && (
                <button
                  type="button"
                  className="text-xs text-zinc-400 underline"
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

