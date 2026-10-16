import { useState } from "react";

import type { AgentKind, McpAddSpec, McpPair, McpServerRow, McpSurface } from "@/types";
import { cn } from "@/lib/utils";
import {
  MCP_PAGE,
  addLabel,
  authStatusLabel,
  defaultScope,
  defaultTransport,
  existingTitle,
  registrationAria,
  rowStatusLine,
  showAdd,
  showLogin,
  showLoginScopes,
  showRegistration,
  showRemove,
  statusTextLabel,
  transportLabel,
  visibleFields,
} from "./view";

const inputClass =
  "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-zinc-500";
const quietButton =
  "rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-100 hover:bg-zinc-800 disabled:opacity-50";

export interface McpPanelProps {
  surfaces: McpSurface[];
  selected: AgentKind | null;
  rows: McpServerRow[];
  listError: string | null;
  busy: boolean;
  notice: string | null;
  toolsText: string | null;
  initialMode?: "list" | "new";
  onSelect: (kind: AgentKind) => void;
  onAdd: (spec: McpAddSpec) => void;
  onRemove: (name: string, scope: string) => void;
  onLogin: (name: string, registration: string, scopes: string) => void;
  onLogout: (name: string) => void;
  onSetEnabled: (name: string, enabled: boolean) => void;
  onListTools: (name: string) => void;
}

export function McpPanel(props: McpPanelProps) {
  const surface = props.surfaces.find((item) => item.kind === props.selected) ?? null;
  const [mode, setMode] = useState<"list" | "new" | "existing">(props.initialMode === "new" ? "new" : "list");
  const [openName, setOpenName] = useState<string | null>(null);
  const openRow = props.rows.find((row) => row.name === openName) ?? null;

  function pick(kind: AgentKind) {
    setMode("list");
    setOpenName(null);
    props.onSelect(kind);
  }

  return (
    <section data-mcp-panel="">
      <h2 className="text-base font-medium text-zinc-100">{MCP_PAGE.nav}</h2>
      <p className="mt-1 max-w-lg text-sm leading-6 text-zinc-500">{MCP_PAGE.subtitle}</p>
      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label={MCP_PAGE.nav}>
        {props.surfaces.map((item) => (
          <button
            key={item.kind}
            type="button"
            role="tab"
            data-mcp-agent={item.kind}
            aria-selected={item.kind === surface?.kind}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm",
              item.kind === surface?.kind ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-100",
            )}
            onClick={() => pick(item.kind)}
          >
            {item.display_name}
          </button>
        ))}
      </div>
      {surface && mode === "new" && showAdd(surface) && (
        <NewServer surface={surface} busy={props.busy} notice={props.notice} onBack={() => setMode("list")} onSave={props.onAdd} />
      )}
      {surface && mode === "existing" && openRow && (
        <ExistingServer
          surface={surface}
          row={openRow}
          busy={props.busy}
          notice={props.notice}
          onBack={() => {
            setMode("list");
            setOpenName(null);
          }}
          onRemove={() => props.onRemove(openRow.name, openRow.scope)}
        />
      )}
      {surface && mode === "list" && (
        <ServerList
          surface={surface}
          rows={props.rows}
          listError={props.listError}
          busy={props.busy}
          notice={props.notice}
          toolsText={props.toolsText}
          onAdd={() => setMode("new")}
          onOpen={(name) => {
            setOpenName(name);
            setMode("existing");
          }}
          onLogin={props.onLogin}
          onLogout={props.onLogout}
          onSetEnabled={props.onSetEnabled}
          onListTools={props.onListTools}
        />
      )}
    </section>
  );
}

function ServerList(props: {
  surface: McpSurface;
  rows: McpServerRow[];
  listError: string | null;
  busy: boolean;
  notice: string | null;
  toolsText: string | null;
  onAdd: () => void;
  onOpen: (name: string) => void;
  onLogin: McpPanelProps["onLogin"];
  onLogout: McpPanelProps["onLogout"];
  onSetEnabled: McpPanelProps["onSetEnabled"];
  onListTools: McpPanelProps["onListTools"];
}) {
  const { surface } = props;
  const [pendingLogin, setPendingLogin] = useState<string | null>(null);
  return (
    <div className="mt-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-zinc-100">{MCP_PAGE.heading}</h3>
        {showAdd(surface) && (
          <button type="button" data-mcp-add="" className={quietButton} onClick={props.onAdd}>
            {MCP_PAGE.add}
          </button>
        )}
      </div>
      {!surface.manageable && surface.unavailable_reason && (
        <p className="mt-4 text-sm leading-6 text-zinc-400" data-mcp-unavailable="">
          {surface.unavailable_reason}
        </p>
      )}
      {props.listError && (
        <p className="mt-4 text-sm leading-6 text-red-300" role="alert">
          {props.listError}
        </p>
      )}
      {props.notice && (
        <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-zinc-300" data-mcp-notice="">
          {props.notice}
        </p>
      )}
      {surface.manageable && props.rows.length === 0 && !props.listError && (
        <p className="mt-8 text-sm text-zinc-500" data-mcp-empty="">
          {MCP_PAGE.empty}
        </p>
      )}
      <ul className="mt-4 space-y-2">
        {props.rows.map((row) => (
          <li key={row.name} data-mcp-row={row.name} className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
            <div className="text-sm font-medium text-zinc-100">{row.name}</div>
            <p className="mt-1 text-xs leading-5 text-zinc-500">{rowStatusLine(surface, row)}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" className={quietButton} data-mcp-settings={row.name} onClick={() => props.onOpen(row.name)}>
                {MCP_PAGE.settings}
              </button>
              {showLogin(surface, row) && (
                <LoginControl
                  surface={surface}
                  row={row}
                  busy={props.busy}
                  starting={pendingLogin === row.name && props.busy}
                  onLogin={(registration, scopes) => {
                    setPendingLogin(row.name);
                    props.onLogin(row.name, registration, scopes);
                  }}
                />
              )}
              {surface.manageable && surface.verbs.enable && (
                <button type="button" className={quietButton} disabled={props.busy} data-mcp-enable={row.name} onClick={() => props.onSetEnabled(row.name, true)}>
                  {MCP_PAGE.enable}
                </button>
              )}
              {surface.manageable && surface.verbs.disable && (
                <button type="button" className={quietButton} disabled={props.busy} data-mcp-disable={row.name} onClick={() => props.onSetEnabled(row.name, false)}>
                  {MCP_PAGE.disable}
                </button>
              )}
              {surface.manageable && surface.verbs.list_tools && surface.tools_label && (
                <button type="button" className={quietButton} disabled={props.busy} data-mcp-tools={row.name} onClick={() => props.onListTools(row.name)}>
                  {surface.tools_label}
                </button>
              )}
              {surface.manageable && surface.verbs.logout && surface.logout_label && (
                <button type="button" className={quietButton} disabled={props.busy} data-mcp-logout={row.name} onClick={() => props.onLogout(row.name)}>
                  {surface.logout_label}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {props.toolsText && (
        <pre className="mt-4 overflow-x-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs text-zinc-300" data-mcp-tools-output="">
          {props.toolsText}
        </pre>
      )}
    </div>
  );
}

function LoginControl(props: {
  surface: McpSurface;
  row: McpServerRow;
  busy: boolean;
  starting: boolean;
  onLogin: (registration: string, scopes: string) => void;
}) {
  const [registration, setRegistration] = useState(props.surface.oauth_registration[0]?.id ?? "");
  const [scopes, setScopes] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      {props.surface.oauth_registration.length > 0 && (
        <select
          aria-label={registrationAria(registration)}
          className={inputClass + " w-auto"}
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
      )}
      {showLoginScopes(props.surface) && (
        <input
          className={inputClass + " w-56"}
          value={scopes}
          placeholder={MCP_PAGE.scopesPlaceholder}
          aria-label={MCP_PAGE.scopesPlaceholder}
          data-mcp-scopes={props.row.name}
          onChange={(event) => setScopes(event.target.value)}
        />
      )}
      <button type="button" className={quietButton} disabled={props.busy} data-mcp-login={props.row.name} onClick={() => props.onLogin(registration, scopes)}>
        {props.starting ? MCP_PAGE.starting : MCP_PAGE.authenticate}
      </button>
    </div>
  );
}

function NewServer(props: {
  surface: McpSurface;
  busy: boolean;
  notice: string | null;
  onBack: () => void;
  onSave: (spec: McpAddSpec) => void;
}) {
  const { surface } = props;
  const [transport, setTransport] = useState(defaultTransport(surface));
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState<string[]>([]);
  const [env, setEnv] = useState<McpPair[]>([]);
  const [url, setUrl] = useState("");
  const [bearer, setBearer] = useState("");
  const [headers, setHeaders] = useState<McpPair[]>([]);
  const [scope, setScope] = useState(defaultScope(surface));
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [oauthResource, setOauthResource] = useState("");
  const [callbackPort, setCallbackPort] = useState("");
  const [registration, setRegistration] = useState(surface.oauth_registration[0]?.id ?? "");
  const [localError, setLocalError] = useState<string | null>(null);
  const fields = visibleFields(surface.fields, transport);
  const shown = new Set(fields.map((field) => field.id));

  function save() {
    if (!name.trim() || (shown.has("command") && !command.trim()) || (shown.has("url") && !url.trim())) {
      setLocalError(MCP_PAGE.saveError);
      return;
    }
    setLocalError(null);
    props.onSave({
      name: name.trim(),
      transport,
      command: shown.has("command") ? command.trim() : "",
      args: shown.has("args") ? args.map((item) => item.trim()).filter(Boolean) : [],
      env: shown.has("env") ? filledPairs(env) : [],
      url: shown.has("url") ? url.trim() : "",
      bearer_token_env_var: shown.has("bearer_token_env_var") ? bearer.trim() : "",
      headers: shown.has("headers") ? filledPairs(headers) : [],
      scope: surface.scopes.length > 0 ? scope : "",
      client_id: shown.has("client_id") ? clientId.trim() : "",
      client_secret: shown.has("client_secret") ? clientSecret : "",
      oauth_resource: shown.has("oauth_resource") ? oauthResource.trim() : "",
      callback_port: shown.has("callback_port") ? callbackPort.trim() : "",
      oauth_registration: showRegistration(surface, transport) ? registration : "",
    });
  }

  return (
    <div className="mt-6" data-mcp-form="new">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-zinc-100">{MCP_PAGE.titleNew}</h3>
        <button type="button" className={quietButton} onClick={props.onBack}>
          {MCP_PAGE.back}
        </button>
      </div>
      <div className="mt-4 space-y-4">
        <TextField id="name" label={labelOf(fields, "name", MCP_PAGE.name)} placeholder={placeholderOf(fields, "name")} value={name} onChange={setName} />
        {surface.transports.length > 0 && (
          <div>
            <div className="mb-2 text-xs text-zinc-400">{MCP_PAGE.typeLabel}</div>
            <div className="flex flex-wrap gap-2" role="group" aria-label={MCP_PAGE.typeAria}>
              {surface.transports.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-mcp-transport={item.id}
                  aria-pressed={transport === item.id}
                  className={cn(quietButton, transport === item.id && "border-zinc-400 bg-zinc-800")}
                  onClick={() => setTransport(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {surface.scopes.length > 0 && surface.scope_label && (
          <label className="block text-xs text-zinc-400">
            {surface.scope_label}
            <select className={inputClass + " mt-1"} value={scope} data-mcp-scope="" aria-label={surface.scope_label} onChange={(event) => setScope(event.target.value)}>
              {surface.scopes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {shown.has("command") && (
          <TextField id="command" label={labelOf(fields, "command", MCP_PAGE.command)} placeholder={placeholderOf(fields, "command")} value={command} onChange={setCommand} />
        )}
        {shown.has("args") && <StringList label={labelOf(fields, "args", MCP_PAGE.args)} addLabel={addLabel("args") ?? MCP_PAGE.args} values={args} onChange={setArgs} />}
        {shown.has("env") && <PairList label={labelOf(fields, "env", MCP_PAGE.env)} addLabel={addLabel("env") ?? MCP_PAGE.env} pairs={env} onChange={setEnv} />}
        {shown.has("url") && <TextField id="url" label={labelOf(fields, "url", MCP_PAGE.url)} placeholder={placeholderOf(fields, "url")} value={url} onChange={setUrl} />}
        {shown.has("bearer_token_env_var") && (
          <TextField id="bearer_token_env_var" label={labelOf(fields, "bearer_token_env_var", MCP_PAGE.bearer)} placeholder={placeholderOf(fields, "bearer_token_env_var")} value={bearer} onChange={setBearer} />
        )}
        {shown.has("headers") && (
          <PairList label={labelOf(fields, "headers", MCP_PAGE.headers)} addLabel={addLabel("headers") ?? MCP_PAGE.headers} pairs={headers} onChange={setHeaders} />
        )}
        {shown.has("client_id") && <TextField id="client_id" label={labelOf(fields, "client_id", "client_id")} placeholder="" value={clientId} onChange={setClientId} />}
        {shown.has("client_secret") && (
          <TextField id="client_secret" label={labelOf(fields, "client_secret", "client_secret")} placeholder="" value={clientSecret} onChange={setClientSecret} secret />
        )}
        {shown.has("oauth_resource") && (
          <TextField id="oauth_resource" label={labelOf(fields, "oauth_resource", "oauth_resource")} placeholder="" value={oauthResource} onChange={setOauthResource} />
        )}
        {shown.has("callback_port") && (
          <TextField id="callback_port" label={labelOf(fields, "callback_port", "callback_port")} placeholder="" value={callbackPort} onChange={setCallbackPort} />
        )}
        {showRegistration(surface, transport) && (
          <label className="block text-xs text-zinc-400">
            {MCP_PAGE.registration}
            <select className={inputClass + " mt-1"} aria-label={registrationAria(registration)} value={registration} data-mcp-add-registration="" onChange={(event) => setRegistration(event.target.value)}>
              {surface.oauth_registration.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {(localError || props.notice) && (
        <p className="mt-4 text-sm text-red-300" role="alert">
          {localError ?? props.notice}
        </p>
      )}
      <button type="button" className={quietButton + " mt-4"} data-mcp-save="" disabled={props.busy} onClick={save}>
        {MCP_PAGE.save}
      </button>
    </div>
  );
}

function ExistingServer(props: {
  surface: McpSurface;
  row: McpServerRow;
  busy: boolean;
  notice: string | null;
  onBack: () => void;
  onRemove: () => void;
}) {
  const { surface, row } = props;
  return (
    <div className="mt-6" data-mcp-form="existing">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-zinc-100">{existingTitle(row.name)}</h3>
        <button type="button" className={quietButton} onClick={props.onBack}>
          {MCP_PAGE.back}
        </button>
      </div>
      <p className="mt-3 text-sm leading-6 text-zinc-400">{MCP_PAGE.switchNotice}</p>
      <dl className="mt-4 space-y-3 text-sm">
        <Readout label={MCP_PAGE.name} value={row.name} />
        {row.transport && <Readout label={MCP_PAGE.typeLabel} value={transportLabel(surface, row.transport)} />}
        {row.command && <Readout label={MCP_PAGE.command} value={[row.command, ...row.args].filter(Boolean).join(" ")} />}
        {row.url && <Readout label={MCP_PAGE.url} value={row.url} />}
        {row.bearer_token_env_var && <Readout label={MCP_PAGE.bearer} value={row.bearer_token_env_var} />}
        {row.cwd && <Readout label={MCP_PAGE.cwd} value={row.cwd} />}
        {row.env.length > 0 && <Readout label={MCP_PAGE.env} value={row.env.map((pair) => `${pair.key}=${pair.value}`).join("\n")} />}
        {row.env_vars.length > 0 && <Readout label={MCP_PAGE.envPassthrough} value={row.env_vars.join("\n")} />}
        {row.headers.length > 0 && <Readout label={MCP_PAGE.headers} value={row.headers.map((pair) => `${pair.key}: ${pair.value}`).join("\n")} />}
        {row.env_headers.length > 0 && <Readout label={MCP_PAGE.envHeaders} value={row.env_headers.map((pair) => `${pair.key}=${pair.value}`).join("\n")} />}
        {row.auth_status && <Readout label={MCP_PAGE.authLabel} value={authStatusLabel(row.auth_status)} />}
        {row.status_text && <Readout label={MCP_PAGE.statusLabel} value={statusTextLabel(row.status_text)} />}
      </dl>
      {props.notice && (
        <p className="mt-4 text-sm text-red-300" role="alert">
          {MCP_PAGE.uninstallError} {props.notice}
        </p>
      )}
      {showRemove(surface) && (
        <button type="button" className={quietButton + " mt-4"} data-mcp-uninstall={row.name} disabled={props.busy} onClick={props.onRemove}>
          {MCP_PAGE.uninstall}
        </button>
      )}
    </div>
  );
}

function TextField(props: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  secret?: boolean;
}) {
  return (
    <label className="block text-xs text-zinc-400">
      {props.label}
      <input
        className={inputClass + " mt-1"}
        data-mcp-field={props.id}
        placeholder={props.placeholder}
        type={props.secret ? "password" : "text"}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function StringList(props: { label: string; addLabel: string; values: string[]; onChange: (values: string[]) => void }) {
  return (
    <div>
      <div className="text-xs text-zinc-400">{props.label}</div>
      <div className="mt-1 space-y-2">
        {props.values.map((value, index) => (
          <div key={index} className="flex gap-2">
            <input
              className={inputClass}
              value={value}
              aria-label={props.label}
              onChange={(event) => {
                const next = props.values.slice();
                next[index] = event.target.value;
                props.onChange(next);
              }}
            />
            <button type="button" className={quietButton} aria-label={MCP_PAGE.removeEntry} onClick={() => props.onChange(props.values.filter((_, item) => item !== index))}>
              {MCP_PAGE.removeEntry}
            </button>
          </div>
        ))}
      </div>
      <button type="button" className={quietButton + " mt-2"} onClick={() => props.onChange([...props.values, ""])}>
        {props.addLabel}
      </button>
    </div>
  );
}

function PairList(props: { label: string; addLabel: string; pairs: McpPair[]; onChange: (pairs: McpPair[]) => void }) {
  return (
    <div>
      <div className="text-xs text-zinc-400">{props.label}</div>
      <div className="mt-1 space-y-2">
        {props.pairs.map((pair, index) => (
          <div key={index} className="flex gap-2">
            <input className={inputClass} placeholder={MCP_PAGE.key} aria-label={MCP_PAGE.key} value={pair.key} onChange={(event) => props.onChange(replacePair(props.pairs, index, { ...pair, key: event.target.value }))} />
            <input className={inputClass} placeholder={MCP_PAGE.value} aria-label={MCP_PAGE.value} value={pair.value} onChange={(event) => props.onChange(replacePair(props.pairs, index, { ...pair, value: event.target.value }))} />
            <button type="button" className={quietButton} aria-label={MCP_PAGE.removeEntry} onClick={() => props.onChange(props.pairs.filter((_, item) => item !== index))}>
              {MCP_PAGE.removeEntry}
            </button>
          </div>
        ))}
      </div>
      <button type="button" className={quietButton + " mt-2"} onClick={() => props.onChange([...props.pairs, { key: "", value: "" }])}>
        {props.addLabel}
      </button>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-1 whitespace-pre-wrap text-zinc-100">{value}</dd>
    </div>
  );
}

function labelOf(fields: { id: string; label: string }[], id: string, fallback: string): string {
  return fields.find((field) => field.id === id)?.label ?? fallback;
}

function placeholderOf(fields: { id: string; placeholder: string }[], id: string): string {
  return fields.find((field) => field.id === id)?.placeholder ?? "";
}

function filledPairs(pairs: McpPair[]): McpPair[] {
  return pairs.filter((pair) => pair.key.trim() || pair.value.trim());
}

function replacePair(pairs: McpPair[], index: number, pair: McpPair): McpPair[] {
  const next = pairs.slice();
  next[index] = pair;
  return next;
}
