import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowUp, ChevronDown, Plus, Shield, X } from "lucide-react";

import { backend } from "@/lib/ipc";
import { filterSkills, insertSkill, skillToken } from "@/lib/skills";
import { filterSlash, slashToken, type SlashCommand } from "@/lib/slash";
import { cn, pendingPrompt } from "@/lib/utils";
import { useWorkbench } from "@/store";
import {
  ACCESS_LABELS,
  ACCESS_OPTIONS,
  effortLabel,
  type AccessMode,
  type AgentModelOption,
  type AgentSkillOption,
  type Attachment,
  type Session,
  type SessionEvent,
} from "@/types";

const EMPTY_FILES: Attachment[] = [];

function placeMenu(anchor: HTMLElement, menu: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = rect.left;
  if (left + width > window.innerWidth - 8) {
    left = window.innerWidth - width - 8;
  }
  left = Math.max(8, left);
  let top = rect.top - height - 8;
  if (top < 8) top = rect.bottom + 8;
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

function useComposerMenu(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (anchor && menu) placeMenu(anchor, menu);
    };
    place();
    const frame = requestAnimationFrame(place);
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, [open, anchorRef, menuRef, onClose]);
}

export function Composer({
  session,
  events,
}: {
  session: Session;
  events: SessionEvent[];
}) {
  const sendMessage = useWorkbench((s) => s.sendMessage);
  const answerPrompt = useWorkbench((s) => s.answerPrompt);
  const setAccessMode = useWorkbench((s) => s.setAccessMode);
  const loadCatalog = useWorkbench((s) => s.loadCatalog);
  const setTuning = useWorkbench((s) => s.setTuning);
  const catalog = useWorkbench((s) => s.catalogs[session.id]);
  const tuning = useWorkbench((s) => s.tuning[session.id]);
  const addAttachments = useWorkbench((s) => s.addAttachments);
  const removeAttachment = useWorkbench((s) => s.removeAttachment);
  const clearAttachments = useWorkbench((s) => s.clearAttachments);
  const mode = useWorkbench((s) => s.accessMode[session.id] ?? "full");
  const files = useWorkbench((s) => s.attachments[session.id] ?? EMPTY_FILES);
  const composerSeed = useWorkbench((s) => s.composerSeed);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [menu, setMenu] = useState<null | "access" | "model">(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [skillIndex, setSkillIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const accessRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const accessMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  const closeMenu = () => setMenu(null);
  useComposerMenu(menu === "access", accessRef, accessMenuRef, closeMenu);
  useComposerMenu(menu === "model", modelRef, modelMenuRef, closeMenu);

  useEffect(() => {
    void loadCatalog(session.id);
  }, [loadCatalog, session.id]);

  useEffect(() => {
    if (!composerSeed || composerSeed.sessionId !== session.id) return;
    setText(composerSeed.text);
    setCaret(composerSeed.text.length);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(composerSeed.text.length, composerSeed.text.length);
    });
  }, [composerSeed, session.id]);

  const pendingId = pendingPrompt(events);
  const busy = session.status === "running";
  const dead = session.status === "stopped" || session.status === "failed";
  const locked = busy || dead;
  const token =
    session.agent === "codex-cli" && !pendingId && !locked ? slashToken(text) : null;
  const slashMatches = token ? filterSlash(token) : [];
  const slashOpen = token !== null && (slashMatches.length > 0 || token.length > 1);
  const activeSlash = slashMatches[Math.min(slashIndex, slashMatches.length - 1)];
  const skillQuery =
    session.agent === "codex-cli" && !pendingId && !locked && !slashOpen
      ? skillToken(text, caret)
      : null;
  const skillMatches = skillQuery !== null ? filterSkills(catalog?.skills ?? [], skillQuery) : [];
  const skillOpen = skillQuery !== null;
  const activeSkill = skillMatches[Math.min(skillIndex, Math.max(skillMatches.length - 1, 0))];
  const selectedModel =
    catalog?.models.find((item) => item.id === tuning?.model) ??
    catalog?.models.find((item) => item.is_default) ??
    catalog?.models[0];
  const selectedEffort =
    tuning?.effort &&
    selectedModel?.efforts.some((item) => item.id === tuning.effort)
      ? tuning.effort
      : selectedModel?.default_effort;
  const modelButton = selectedModel
    ? `${selectedModel.label} · ${effortLabel(selectedEffort)}`
    : catalog
      ? "暂无模型"
      : "读取模型…";

  useEffect(() => {
    setSlashIndex(0);
  }, [token]);

  useEffect(() => {
    setSkillIndex(0);
  }, [skillQuery]);

  const placeholder = dead ? "会话已停止，请新建会话" : "随心输入";

  const applySlash = (cmd: SlashCommand) => {
    setText(cmd.takesArgs ? `${cmd.name} ` : cmd.name);
    textareaRef.current?.focus();
  };

  const applySkill = (skill: AgentSkillOption) => {
    const next = insertSkill(text, caret, skill.mention);
    setText(next);
    const nextCaret = next.length;
    setCaret(nextCaret);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.length, next.length);
    });
  };

  const rememberCaret = (element: HTMLTextAreaElement) => {
    setCaret(element.selectionStart ?? element.value.length);
  };

  const submit = () => {
    const value = text.trim();
    if (!value || locked) return;
    const attached = useWorkbench.getState().attachments[session.id] ?? [];
    setText("");
    if (pendingId) {
      answerPrompt(session.id, pendingId, value);
    } else {
      const slash = value.startsWith("/");
      const body =
        !slash && attached.length > 0
          ? `${value}\n\n附件：${attached.map((file) => file.name).join("、")}`
          : value;
      sendMessage(session.id, body);
      if (!slash) clearAttachments(session.id);
    }
    textareaRef.current?.focus();
  };

  const pickFiles = async () => {
    if (locked) return;
    const picked = await backend.pickFiles();
    if (picked.length) addAttachments(session.id, picked);
  };

  return (
    <div className="shrink-0 px-4 pb-4 pt-1">
      <div className="relative mx-auto max-w-3xl">
      {skillOpen && (
        <div
          role="listbox"
          aria-label="技能"
          className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
        >
          {skillMatches.length === 0 ? (
            <p className="px-3 py-2 text-xs text-zinc-500">
              {catalog ? "没有匹配的技能" : "正在读取技能…"}
            </p>
          ) : (
            skillMatches.map((skill) => (
              <button
                key={skill.path}
                type="button"
                role="option"
                aria-selected={skill === activeSkill}
                className={cn(
                  "flex w-full items-baseline gap-3 px-3 py-2 text-left hover:bg-zinc-800",
                  skill === activeSkill && "bg-zinc-800",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  applySkill(skill);
                }}
              >
                <span className="font-mono text-sm text-zinc-100">{`$${skill.mention}`}</span>
                <span className="truncate text-xs text-zinc-500">
                  {skill.label}
                  {skill.description ? ` · ${skill.description}` : ""}
                </span>
              </button>
            ))
          )}
        </div>
      )}
      {slashOpen && (
        <div
          role="listbox"
          aria-label="斜杠命令"
          className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
        >
          {slashMatches.length === 0 && (
            <p className="px-3 py-2 text-xs text-zinc-500">
              这条斜杠命令不会发给模型。回车后会在时间线里说明。
            </p>
          )}
          {slashMatches.map((cmd, index) => (
            <button
              key={cmd.name}
              type="button"
              role="option"
              aria-selected={index === Math.min(slashIndex, slashMatches.length - 1)}
              className={cn(
                "flex w-full items-baseline gap-3 px-3 py-2 text-left hover:bg-zinc-800",
                index === Math.min(slashIndex, slashMatches.length - 1) && "bg-zinc-800",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                applySlash(cmd);
              }}
            >
              <span className="font-mono text-sm text-zinc-100">{cmd.name}</span>
              <span className="truncate text-xs text-zinc-500">{cmd.hint}</span>
            </button>
          ))}
          {token === "/" && (
            <p className="border-t border-zinc-800 px-3 py-2 text-[11px] leading-4 text-zinc-600">
              /vim、/theme 等终端命令可以输入，但不会发给模型。
            </p>
          )}
        </div>
      )}
      <div
        className="rounded-[28px] border border-zinc-700/90 bg-zinc-900 px-3 pb-2.5 pt-3 shadow-lg shadow-black/20 transition-colors focus-within:border-zinc-500"
        onClick={() => textareaRef.current?.focus()}
      >
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5 px-1">
            {files.map((file) => (
              <span
                key={file.path}
                title={file.path}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200"
              >
                <span className="truncate">{file.name}</span>
                <button
                  type="button"
                  className="rounded-full text-zinc-400 hover:text-zinc-100"
                  aria-label={`移除 ${file.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeAttachment(session.id, file.path);
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            rememberCaret(e.target);
          }}
          onSelect={(e) => rememberCaret(e.currentTarget)}
          onKeyDown={(e) => {
            if (skillOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setSkillIndex((current) => {
                const count = skillMatches.length;
                if (count === 0) return 0;
                const next = e.key === "ArrowDown" ? current + 1 : current - 1;
                return (next + count) % count;
              });
              return;
            }
            if (
              skillOpen &&
              e.key === "Tab" &&
              activeSkill &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              applySkill(activeSkill);
              return;
            }
            if (slashOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setSlashIndex((current) => {
                const count = slashMatches.length;
                if (count === 0) return 0;
                const next = e.key === "ArrowDown" ? current + 1 : current - 1;
                return (next + count) % count;
              });
              return;
            }
            if (
              slashOpen &&
              e.key === "Tab" &&
              activeSlash &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              applySlash(activeSlash);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              const completingSlash =
                slashOpen &&
                activeSlash &&
                token !== activeSlash.name &&
                !text.trim().includes(" ");
              if (completingSlash) {
                e.preventDefault();
                applySlash(activeSlash);
                return;
              }
              const completingSkill =
                skillOpen &&
                activeSkill &&
                skillQuery !== activeSkill.mention.toLowerCase();
              if (completingSkill) {
                e.preventDefault();
                applySkill(activeSkill);
                return;
              }
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          disabled={locked}
          rows={Math.min(6, Math.max(2, text.split("\n").length))}
          className="max-h-40 w-full resize-none bg-transparent px-2 text-sm leading-6 text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="添加附件"
              title="添加附件"
              disabled={locked}
              onClick={(event) => {
                event.stopPropagation();
                void pickFiles();
              }}
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              ref={accessRef}
              type="button"
              className={cn(
                "inline-flex h-8 max-w-full items-center gap-1 rounded-full px-2 text-sm hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40",
                mode === "full" ? "text-orange-400" : "text-zinc-300",
              )}
              aria-label="权限"
              aria-haspopup="menu"
              aria-expanded={menu === "access"}
              disabled={locked}
              onClick={(event) => {
                event.stopPropagation();
                setMenu((current) => (current === "access" ? null : "access"));
              }}
            >
              <Shield className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{ACCESS_LABELS[mode]}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
            </button>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              ref={modelRef}
              type="button"
              className="inline-flex h-8 max-w-52 items-center gap-1 rounded-full px-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="模型"
              aria-haspopup="menu"
              aria-expanded={menu === "model"}
              disabled={locked || !catalog}
              onClick={(event) => {
                event.stopPropagation();
                setMenu((current) => (current === "model" ? null : "model"));
              }}
            >
              <span className="truncate">{modelButton}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                submit();
              }}
              disabled={!text.trim() || locked}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-100 text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
              title="发送"
              aria-label="发送"
            >
              <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>
      </div>
      {menu === "access" && (
        <AccessMenu
          menuRef={accessMenuRef}
          mode={mode}
          onPick={(next) => {
            setAccessMode(session.id, next);
            setMenu(null);
          }}
        />
      )}
      {menu === "model" && (
        <ModelMenu
          menuRef={modelMenuRef}
          models={catalog?.models ?? []}
          modelId={selectedModel?.id}
          effortId={selectedEffort}
          onModel={(next) => {
            const effort = next.efforts.some((item) => item.id === selectedEffort)
              ? selectedEffort || next.default_effort
              : next.default_effort || next.efforts[0]?.id || "";
            setTuning(session.id, next.id, effort);
            setMenu(null);
          }}
          onEffort={(effort) => {
            if (!selectedModel) return;
            setTuning(session.id, selectedModel.id, effort);
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

function AccessMenu({
  menuRef,
  mode,
  onPick,
}: {
  menuRef: RefObject<HTMLDivElement>;
  mode: AccessMode;
  onPick: (mode: AccessMode) => void;
}) {
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="权限"
      className="fixed z-50 w-44 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
      style={{ top: -9999, left: 8 }}
    >
      {ACCESS_OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          role="menuitemradio"
          aria-checked={mode === option}
          className={cn(
            "flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-800",
            option === "full" ? "text-orange-400" : "text-zinc-200",
            mode === option && "bg-zinc-800/70",
          )}
          onClick={() => onPick(option)}
        >
          <Shield className="h-3.5 w-3.5" />
          {ACCESS_LABELS[option]}
        </button>
      ))}
    </div>
  );
}

function ModelMenu({
  menuRef,
  models,
  modelId,
  effortId,
  onModel,
  onEffort,
}: {
  menuRef: RefObject<HTMLDivElement>;
  models: AgentModelOption[];
  modelId?: string;
  effortId?: string;
  onModel: (model: AgentModelOption) => void;
  onEffort: (effort: string) => void;
}) {
  const current = models.find((item) => item.id === modelId) ?? models[0];
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="模型"
      className="fixed z-50 max-h-80 w-72 overflow-y-auto rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
      style={{ top: -9999, left: 8 }}
    >
      <p className="px-3 pb-1 pt-2 text-[11px] text-zinc-500">模型</p>
      {models.length === 0 ? (
        <p className="px-3 py-2 text-xs text-zinc-500">当前 Agent 没有可选模型</p>
      ) : (
        models.map((model) => (
          <button
            key={model.id}
            type="button"
            role="menuitemradio"
            aria-checked={model.id === modelId}
            title={model.description}
            className={cn(
              "block w-full px-3 py-2 text-left hover:bg-zinc-800",
              model.id === modelId && "bg-zinc-800/70",
            )}
            onClick={() => onModel(model)}
          >
            <span className="block text-sm text-zinc-100">{model.label}</span>
            {model.description && (
              <span className="block truncate text-[11px] text-zinc-500">
                {model.description}
              </span>
            )}
          </button>
        ))
      )}
      {current && current.efforts.length > 0 && (
        <>
          <div className="mx-2 my-1 border-t border-zinc-800" />
          <p className="px-3 pb-1 pt-1 text-[11px] text-zinc-500">推理强度</p>
          {current.efforts.map((effort) => (
            <button
              key={effort.id}
              type="button"
              role="menuitemradio"
              aria-checked={effort.id === effortId}
              title={effort.description}
              className={cn(
                "flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-zinc-800",
                effort.id === effortId && "bg-zinc-800/70",
              )}
              onClick={() => onEffort(effort.id)}
            >
              <span className="text-sm text-zinc-100">{effortLabel(effort.id)}</span>
              {effort.description && (
                <span className="truncate text-[11px] text-zinc-500">
                  {effort.description}
                </span>
              )}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
