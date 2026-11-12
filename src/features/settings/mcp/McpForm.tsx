import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";

import type { McpAddSpec, McpField, McpPair, McpSurface } from "@/types";
import { cn } from "@/lib/utils";
import {
  FORM_TEXT,
  applyServerPaste,
  createDraft,
  draftToSpec,
  pairCopyText,
  parseListPaste,
  parsePairPaste,
  readServerPaste,
  validateDraft,
  type McpFormDraft,
} from "./formDraft";
import { MCP_PAGE, addLabel, registrationAria, showRegistration, showScopePicker, visibleFields } from "./view";

const inputClass =
  "w-full rounded-lg border border-wb-border-strong bg-wb-input px-3 py-2 text-sm text-wb-fg outline-none transition-colors placeholder:text-wb-dim focus-visible:border-wb-accent focus-visible:ring-2 focus-visible:ring-wb-accent-soft";
const quietButton =
  "rounded-lg border border-wb-border bg-wb-elev px-3 py-1.5 text-sm text-wb-fg transition-colors hover:border-wb-border-strong hover:bg-wb-hover disabled:opacity-50";

export function McpForm(props: {
  surface: McpSurface;
  existingNames: readonly string[];
  busy: boolean;
  onBack: () => void;
  onSave: (spec: McpAddSpec) => Promise<boolean> | boolean;
}) {
  const { surface } = props;
  const [draft, setDraft] = useState<McpFormDraft>(() => createDraft(surface));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ tone: "alert" | "status"; text: string } | null>(null);
  const [focus, setFocus] = useState<{ id: string; token: number } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [secretOpen, setSecretOpen] = useState<Record<string, boolean>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const saving = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const fields = visibleFields(surface.fields, draft.transport);
  const [first, ...rest] = fields;

  useEffect(() => {
    if (!focus) return;
    const node = formRef.current?.querySelector(`[data-mcp-focus="${CSS.escape(focus.id)}"]`);
    if (!(node instanceof HTMLElement)) return;
    node.focus();
    node.scrollIntoView({ block: "nearest" });
  }, [focus]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  function clearField(id: string) {
    setErrors((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    setNotice(null);
  }

  function putText(id: string, value: string) {
    setDraft((current) => ({ ...current, values: { ...current.values, [id]: value } }));
    clearField(id);
  }

  function putList(id: string, values: string[]) {
    setDraft((current) => ({ ...current, lists: { ...current.lists, [id]: values } }));
    clearField(id);
  }

  function putPairs(id: string, pairs: McpPair[]) {
    setDraft((current) => ({ ...current, pairs: { ...current.pairs, [id]: pairs } }));
    clearField(id);
  }

  async function save() {
    if (saving.current || props.busy) return;
    const checked = validateDraft(surface, draft, props.existingNames);
    setErrors(checked.errors);
    if (checked.focusId) {
      setNotice(null);
      setFocus({ id: checked.focusId, token: Date.now() });
      return;
    }
    saving.current = true;
    try {
      await props.onSave(draftToSpec(surface, draft));
    } finally {
      saving.current = false;
    }
  }

  function applyText(text: string) {
    const read = readServerPaste(text);
    if (!read.ok) {
      setNotice({ tone: "alert", text: read.error });
      return;
    }
    const applied = applyServerPaste(surface, draftRef.current, read.server);
    if ("error" in applied) {
      setNotice({ tone: "alert", text: applied.error });
      return;
    }
    setDraft(applied.draft);
    setErrors({});
    setNotice(applied.notice ? { tone: "status", text: applied.notice } : null);
    setFocus({ id: "name", token: Date.now() });
  }

  async function pasteConfig() {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setNotice({ tone: "alert", text: FORM_TEXT.pasteFailed });
      return;
    }
    applyText(text);
  }

  async function copyPair(id: string, index: number, pair: McpPair) {
    const token = `${id}:${index}`;
    try {
      await navigator.clipboard.writeText(pairCopyText(pair));
      setCopied(token);
    } catch {
      setNotice({ tone: "alert", text: FORM_TEXT.copyFailed });
    }
  }

  function onFormPaste(event: ClipboardEvent<HTMLFormElement>) {
    const text = event.clipboardData.getData("text");
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("```")) return;
    const read = readServerPaste(text);
    if (!read.ok) return;
    event.preventDefault();
    applyText(text);
  }

  return (
    <form
      ref={formRef}
      className="mt-6"
      data-mcp-form="new"
      autoComplete="off"
      spellCheck={false}
      onPaste={onFormPaste}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-wb-fg">{MCP_PAGE.titleNew}</h3>
        <div className="flex gap-2">
          <button type="button" className={quietButton} data-mcp-paste="config" disabled={props.busy} onClick={() => void pasteConfig()}>
            {FORM_TEXT.pasteConfig}
          </button>
          <button type="button" className={quietButton} onClick={props.onBack}>
            {MCP_PAGE.back}
          </button>
        </div>
      </div>
      {notice && (
        <p
          className={cn("mt-4 text-sm", notice.tone === "alert" ? "text-wb-danger" : "text-wb-fg-2")}
          role={notice.tone === "alert" ? "alert" : "status"}
          data-mcp-form-message={notice.tone}
        >
          {notice.text}
        </p>
      )}
      <div className="mt-4 space-y-4">
        {first && (
          <Field
            autoFocus
            field={first}
            draft={draft}
            error={errors[first.id]}
            focusId={focus?.id ?? null}
            busy={props.busy}
            copied={copied}
            secretOpen={secretOpen[first.id] === true}
            onText={putText}
            onList={putList}
            onPairs={putPairs}
            onCopy={(index, pair) => void copyPair(first.id, index, pair)}
            onToggleSecret={() => setSecretOpen((current) => ({ ...current, [first.id]: !current[first.id] }))}
          />
        )}
        {surface.transports.length > 0 && (
          <div>
            <div className="mb-2 text-xs text-wb-fg-2">{MCP_PAGE.typeLabel}</div>
            <div className="flex flex-wrap gap-2" role="group" aria-label={MCP_PAGE.typeAria}>
              {surface.transports.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-mcp-transport={item.id}
                  aria-pressed={draft.transport === item.id}
                  className={cn(quietButton, draft.transport === item.id && "border-wb-accent bg-wb-accent-soft text-wb-fg")}
                  disabled={props.busy}
                  onClick={() => {
                    setDraft((current) => ({ ...current, transport: item.id }));
                    setErrors({});
                    setNotice(null);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {showScopePicker(surface) && (
          <label className="block text-xs text-wb-fg-2">
            {surface.scope_label}
            <select
              className={inputClass + " mt-1"}
              value={draft.scope}
              data-mcp-scope=""
              aria-label={surface.scope_label}
              disabled={props.busy}
              onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value }))}
            >
              {surface.scopes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {rest.map((field) => (
          <Field
            key={field.id}
            field={field}
            draft={draft}
            error={errors[field.id]}
            focusId={focus?.id ?? null}
            busy={props.busy}
            copied={copied}
            secretOpen={secretOpen[field.id] === true}
            onText={putText}
            onList={putList}
            onPairs={putPairs}
            onCopy={(index, pair) => void copyPair(field.id, index, pair)}
            onToggleSecret={() => setSecretOpen((current) => ({ ...current, [field.id]: !current[field.id] }))}
          />
        ))}
        {showRegistration(surface, draft.transport) && (
          <label className="block text-xs text-wb-fg-2">
            {MCP_PAGE.registration}
            <select
              className={inputClass + " mt-1"}
              aria-label={registrationAria(draft.registration)}
              value={draft.registration}
              data-mcp-add-registration=""
              disabled={props.busy}
              onChange={(event) => setDraft((current) => ({ ...current, registration: event.target.value }))}
            >
              {surface.oauth_registration.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <button
        type="submit"
        className="mt-4 rounded-lg bg-wb-primary px-4 py-1.5 text-sm font-medium text-wb-primary-fg transition-colors hover:bg-wb-primary-hover disabled:opacity-50"
        data-mcp-save=""
        disabled={props.busy}
      >
        {MCP_PAGE.save}
      </button>
    </form>
  );
}

function Field(props: {
  autoFocus?: boolean;
  field: McpField;
  draft: McpFormDraft;
  error?: string;
  focusId: string | null;
  busy: boolean;
  copied: string | null;
  secretOpen: boolean;
  onText: (id: string, value: string) => void;
  onList: (id: string, values: string[]) => void;
  onPairs: (id: string, pairs: McpPair[]) => void;
  onCopy: (index: number, pair: McpPair) => void;
  onToggleSecret: () => void;
}) {
  const { field } = props;
  const invalid = Boolean(props.error);
  const focusAttr = props.focusId === field.id ? field.id : undefined;
  if (field.control === "list") {
    return (
      <StringList
        field={field}
        values={props.draft.lists[field.id] ?? []}
        error={props.error}
        focusId={focusAttr}
        busy={props.busy}
        onChange={(values) => props.onList(field.id, values)}
      />
    );
  }
  if (field.control === "pairs") {
    return (
      <PairList
        field={field}
        pairs={props.draft.pairs[field.id] ?? []}
        error={props.error}
        focusId={focusAttr}
        busy={props.busy}
        copied={props.copied}
        onChange={(pairs) => props.onPairs(field.id, pairs)}
        onCopy={props.onCopy}
      />
    );
  }
  const value = props.draft.values[field.id] ?? "";
  const secret = field.control === "secret";
  return (
    <label className="block text-xs text-wb-fg-2" data-mcp-required={field.required ? field.id : undefined}>
      <FieldLabel field={field} />
      <span className="mt-1 flex gap-2">
        <input
          className={fieldClass(invalid)}
          data-mcp-field={field.id}
          data-mcp-focus={focusAttr}
          placeholder={field.placeholder}
          type={secret && !props.secretOpen ? "password" : "text"}
          inputMode={field.rule === "port" ? "numeric" : undefined}
          aria-invalid={invalid || undefined}
          aria-required={field.required || undefined}
          autoFocus={props.autoFocus}
          disabled={props.busy}
          value={value}
          onChange={(event) => props.onText(field.id, event.target.value)}
        />
        {secret && (
          <button type="button" className={quietButton + " shrink-0"} disabled={props.busy} onClick={props.onToggleSecret}>
            {props.secretOpen ? FORM_TEXT.hideSecret : FORM_TEXT.showSecret}
          </button>
        )}
      </span>
      <FieldError id={field.id} error={props.error} />
    </label>
  );
}

function StringList(props: {
  field: McpField;
  values: string[];
  error?: string;
  focusId?: string;
  busy: boolean;
  onChange: (values: string[]) => void;
}) {
  const rows = props.values.length > 0 ? props.values : [""];
  const synthetic = props.values.length === 0;
  return (
    <div data-mcp-list={props.field.id} data-mcp-required={props.field.required ? props.field.id : undefined}>
      <FieldLabel field={props.field} />
      <p className="mt-1 text-xs text-wb-fg-3">{FORM_TEXT.pasteList}</p>
      <div className="mt-2 space-y-2">
        {rows.map((value, index) => (
          <div key={index} className="flex gap-2">
            <input
              className={fieldClass(Boolean(props.error))}
              value={value}
              aria-label={props.field.label}
              aria-invalid={props.error ? true : undefined}
              data-mcp-focus={index === 0 ? props.focusId : undefined}
              disabled={props.busy}
              onChange={(event) => props.onChange(replaceAt(rows, index, event.target.value))}
              onPaste={(event) => {
                const text = event.clipboardData.getData("text");
                const trimmed = text.trim();
                if ((trimmed.startsWith("{") || trimmed.startsWith("```")) && readServerPaste(text).ok) return;
                const parsed = parseListPaste(text);
                if (!parsed) return;
                event.preventDefault();
                const next = rows.slice();
                next.splice(index, 1, ...parsed);
                props.onChange(next.filter((item) => item.trim() || next.length === 1));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
            />
            <button
              type="button"
              className={quietButton + " shrink-0"}
              aria-label={MCP_PAGE.removeEntry}
              disabled={props.busy || (synthetic && !value)}
              onClick={() => props.onChange(rows.filter((_, item) => item !== index))}
            >
              {MCP_PAGE.removeEntry}
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className={quietButton + " mt-2"}
        disabled={props.busy}
        onClick={() => props.onChange([...rows, ""])}
      >
        {addLabel(props.field.id) ?? props.field.label}
      </button>
      <FieldError id={props.field.id} error={props.error} />
    </div>
  );
}

function PairList(props: {
  field: McpField;
  pairs: McpPair[];
  error?: string;
  focusId?: string;
  busy: boolean;
  copied: string | null;
  onChange: (pairs: McpPair[]) => void;
  onCopy: (index: number, pair: McpPair) => void;
}) {
  const rows = props.pairs.length > 0 ? props.pairs : [{ key: "", value: "" }];
  const synthetic = props.pairs.length === 0;
  return (
    <div data-mcp-pairs={props.field.id} data-mcp-required={props.field.required ? props.field.id : undefined}>
      <FieldLabel field={props.field} />
      <p className="mt-1 text-xs text-wb-fg-3">{FORM_TEXT.pastePairs}</p>
      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2 text-xs text-wb-fg-3">
        <span>{MCP_PAGE.key}</span>
        <span>{MCP_PAGE.value}</span>
        <span />
      </div>
      <div className="mt-1 space-y-2">
        {rows.map((pair, index) => {
          const token = `${props.field.id}:${index}`;
          const empty = !pair.key.trim() && !pair.value.trim();
          return (
            <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2">
              <input
                className={fieldClass(Boolean(props.error))}
                placeholder={MCP_PAGE.key}
                aria-label={MCP_PAGE.key}
                aria-invalid={props.error ? true : undefined}
                data-mcp-focus={index === 0 ? props.focusId : undefined}
                value={pair.key}
                disabled={props.busy}
                onChange={(event) => props.onChange(replacePair(rows, index, { ...pair, key: event.target.value }))}
                onPaste={(event) => pastePairs(event, rows, index, props.onChange, "key")}
                onKeyDown={blockEnter}
              />
              <input
                className={fieldClass(Boolean(props.error))}
                placeholder={MCP_PAGE.value}
                aria-label={MCP_PAGE.value}
                aria-invalid={props.error ? true : undefined}
                value={pair.value}
                disabled={props.busy}
                onChange={(event) => props.onChange(replacePair(rows, index, { ...pair, value: event.target.value }))}
                onPaste={(event) => pastePairs(event, rows, index, props.onChange, "value")}
                onKeyDown={blockEnter}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className={quietButton + " shrink-0"}
                  disabled={props.busy || empty}
                  onClick={() => props.onCopy(index, pair)}
                >
                  {props.copied === token ? FORM_TEXT.copied : FORM_TEXT.copyEntry}
                </button>
                <button
                  type="button"
                  className={quietButton + " shrink-0"}
                  aria-label={MCP_PAGE.removeEntry}
                  disabled={props.busy || (synthetic && empty)}
                  onClick={() => props.onChange(rows.filter((_, item) => item !== index))}
                >
                  {MCP_PAGE.removeEntry}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className={quietButton + " mt-2"}
        disabled={props.busy}
        onClick={() => props.onChange([...rows, { key: "", value: "" }])}
      >
        {addLabel(props.field.id) ?? props.field.label}
      </button>
      <FieldError id={props.field.id} error={props.error} />
    </div>
  );
}

function FieldLabel({ field }: { field: McpField }) {
  return (
    <span className="text-xs text-wb-fg-2">
      {field.label}
      {field.required && (
        <span className="ml-1 text-wb-danger" aria-hidden>
          *
        </span>
      )}
    </span>
  );
}

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null;
  return (
    <p className="mt-1 text-xs text-wb-danger" role="alert" data-mcp-field-error={id}>
      {error}
    </p>
  );
}

function fieldClass(invalid: boolean): string {
  return cn(inputClass, "mt-0", invalid && "border-wb-danger/40 focus-visible:border-wb-danger");
}

function pastePairs(
  event: ClipboardEvent<HTMLInputElement>,
  rows: McpPair[],
  index: number,
  onChange: (pairs: McpPair[]) => void,
  target: "key" | "value",
) {
  const text = event.clipboardData.getData("text");
  const trimmed = text.trim();
  if ((trimmed.startsWith("{") || trimmed.startsWith("```")) && readServerPaste(text).ok) return;
  const parsed = parsePairPaste(text);
  if (!parsed) return;
  const block = text.includes("\n") || text.trim().startsWith("{") || text.trim().startsWith("[");
  if (target === "value" && !block) return;
  event.preventDefault();
  event.stopPropagation();
  const next = rows.slice();
  next.splice(index, 1, ...parsed);
  onChange(next);
}

function blockEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === "Enter") event.preventDefault();
}

function replaceAt(values: string[], index: number, value: string): string[] {
  const next = values.slice();
  next[index] = value;
  return next;
}

function replacePair(pairs: McpPair[], index: number, pair: McpPair): McpPair[] {
  const next = pairs.slice();
  next[index] = pair;
  return next;
}
