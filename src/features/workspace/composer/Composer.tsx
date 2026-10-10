import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ArrowUp, ChevronDown, Pencil, Plus, Shield, Trash2, X } from "lucide-react";

import { modelButtonLabel, preferCatalog } from "@/lib/catalog";
import { backend } from "@/lib/ipc";
import { filterSkills, insertSkill, skillToken } from "./skills";
import { filterSlash, slashToken } from "@/lib/slash";
import { cn, isReadOnlyOpen, pendingPrompt } from "@/lib/utils";
import { fileName, fileToBase64, isImagePath } from "./media";
import { ChatThumb } from "../timeline/ChatThumb";
import { useWorkbench } from "@/store";
import {
  ACCESS_LABELS,
  ACCESS_OPTIONS,
  effortLabel,
  type AccessMode,
  type AgentModelOption,
  type AgentSkillOption,
  type Attachment,
  type QueuedTurn,
  type Session,
  type SessionEvent,
  type SlashCommand,
} from "@/types";

const EMPTY_FILES: Attachment[] = [];
const EMPTY_QUEUE: QueuedTurn[] = [];

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

function stepIndex(current: number, count: number, key: string) {
  if (count === 0) return 0;
  const next = key === "ArrowDown" ? current + 1 : current - 1;
  return (next + count) % count;
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
  const liveCatalog = useWorkbench((s) => s.catalogs[session.id]);
  const cachedCatalog = useWorkbench((s) => s.catalogCache[session.agent]);
  const catalogNotice = useWorkbench((s) => s.catalogNotice);
  const catalog = preferCatalog(liveCatalog, cachedCatalog);
  const profile = useWorkbench((s) => s.profiles[session.agent]);
  const tuning = useWorkbench((s) => s.tuning[session.id]);
  const addAttachments = useWorkbench((s) => s.addAttachments);
  const removeAttachment = useWorkbench((s) => s.removeAttachment);
  const clearAttachments = useWorkbench((s) => s.clearAttachments);
  const replaceAttachments = useWorkbench((s) => s.replaceAttachments);
  const mode = useWorkbench((s) => s.accessMode[session.id] ?? "full");
  const files = useWorkbench((s) => s.attachments[session.id] ?? EMPTY_FILES);
  const queue = useWorkbench((s) => s.queues[session.id] ?? EMPTY_QUEUE);
  const composerSeed = useWorkbench((s) => s.composerSeed);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [menu, setMenu] = useState<null | "access" | "model" | "attach">(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [skillIndex, setSkillIndex] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const accessRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const accessMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => setMenu(null), []);
  useComposerMenu(menu === "access", accessRef, accessMenuRef, closeMenu);
  useComposerMenu(menu === "model", modelRef, modelMenuRef, closeMenu);
  useComposerMenu(menu === "attach", plusRef, attachMenuRef, closeMenu);

  useEffect(() => {
    void loadCatalog(session.id);
  }, [loadCatalog, session.id]);

  useEffect(() => {
    let cancelled = false;
    void backend.sessionQueue(session.id).then((items) => {
      if (cancelled) return;
      useWorkbench.setState((s) => ({
        queues: { ...s.queues, [session.id]: items },
      }));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  useEffect(() => {
    if (!composerSeed || composerSeed.sessionId !== session.id) return;
    setEditingId(null);
    setText(composerSeed.text);
    setCaret(composerSeed.text.length);
    replaceAttachments(
      session.id,
      composerSeed.images.map((path) => ({ path, name: fileName(path) })),
    );
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(composerSeed.text.length, composerSeed.text.length);
    });
  }, [composerSeed, replaceAttachments, session.id]);

  const pendingId = pendingPrompt(events);
  const occupied = isReadOnlyOpen(events);
  const busy = session.status === "running";
  const dead = session.status === "stopped" || session.status === "failed";
  const caps = profile?.capabilities ?? catalog?.capabilities;
  const imagesOn = Boolean(caps?.supports_images);
  const queueOn = Boolean(caps?.supports_queue);
  const composerLocked = queueOn ? dead || occupied : busy || dead || occupied;
  const menusLocked = busy || dead || occupied;
  const commands = profile?.commands ?? catalog?.commands ?? [];
  const token =
    caps?.supports_slash && !pendingId && !menusLocked ? slashToken(text) : null;
  const slashMatches = token ? filterSlash(commands, token) : [];
  const slashOpen = token !== null && (slashMatches.length > 0 || token.length > 1);
  const activeSlash = slashMatches[Math.min(slashIndex, slashMatches.length - 1)];
  const skillQuery =
    caps?.supports_skills && !pendingId && !menusLocked && !slashOpen
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
  const modelButton = modelButtonLabel(
    selectedModel ? `${selectedModel.label} · ${effortLabel(selectedEffort)}` : undefined,
    catalog,
    catalogNotice,
  );

  useEffect(() => {
    setSlashIndex(0);
  }, [token]);

  useEffect(() => {
    setSkillIndex(0);
  }, [skillQuery]);

  const placeholder = occupied
    ? "此会话正被其他进程占用，只能查看"
    : dead
      ? "会话已停止，请新建会话"
      : queueOn && busy
        ? "添加后续消息"
        : "随心输入";

  const applySlash = (cmd: SlashCommand) => {
    setText(cmd.takes_args ? `${cmd.name} ` : cmd.name);
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

  const cancelEdit = () => {
    setEditingId(null);
    setText("");
    setCaret(0);
    clearAttachments(session.id);
  };

  const stageBlobs = async (blobs: File[]) => {
    const images = blobs.filter((file) => file.type.startsWith("image/") || isImagePath(file.name));
    const rejected = blobs.length > images.length;
    if (rejected) setNotice("只能附加图片");
    if (images.length === 0) return;
    const staged = [];
    for (const file of images) {
      const data = await fileToBase64(file);
      staged.push(await backend.stageChatImage(data, file.name || "image.png"));
    }
    if (staged.length) {
      if (!rejected) setNotice(null);
      addAttachments(session.id, staged);
    }
  };

  const submit = () => {
    const value = text.trim();
    const attached = useWorkbench.getState().attachments[session.id] ?? [];
    const imagePaths = imagesOn ? attached.map((file) => file.path) : [];
    if (editingId) {
      if (!value && imagePaths.length === 0) return;
      const queuedId = editingId;
      setEditingId(null);
      setText("");
      clearAttachments(session.id);
      void backend
        .updateQueuedTurn(session.id, queuedId, value, imagePaths)
        .catch((error: unknown) => {
          useWorkbench.setState({ lastError: String(error) });
        });
      textareaRef.current?.focus();
      return;
    }
    if (pendingId) {
      if (!value || composerLocked) return;
      setText("");
      answerPrompt(session.id, pendingId, { type: "single", value });
      textareaRef.current?.focus();
      return;
    }
    const canSend = imagesOn ? Boolean(value || imagePaths.length) : Boolean(value);
    if (!canSend || composerLocked) return;
    setText("");
    if (imagesOn) {
      void sendMessage(session.id, value, imagePaths);
      clearAttachments(session.id);
    } else {
      const slash = value.startsWith("/");
      const body =
        !slash && attached.length > 0
          ? `${value}\n\n附件：${attached.map((file) => file.name).join("、")}`
          : value;
      void sendMessage(session.id, body);
      if (!slash) clearAttachments(session.id);
    }
    textareaRef.current?.focus();
  };

  const pickFiles = async () => {
    if (composerLocked) return;
    setMenu(null);
    const picked = imagesOn ? await backend.pickImageFiles() : await backend.pickFiles();
    if (!picked.length) return;
    if (imagesOn) {
      const images = picked.filter((file) => isImagePath(file.path));
      if (images.length !== picked.length) setNotice("只能附加图片");
      if (images.length) {
        setNotice(images.length === picked.length ? null : "只能附加图片");
        addAttachments(session.id, images);
      }
      return;
    }
    addAttachments(session.id, picked);
  };

  const beginEdit = (item: QueuedTurn) => {
    setEditingId(item.id);
    setText(item.text);
    setCaret(item.text.length);
    replaceAttachments(
      session.id,
      (item.images ?? []).map((path) => ({ path, name: fileName(path) })),
    );
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const stopMode =
    queueOn && busy && !editingId && !pendingId && !text.trim() && files.length === 0;

  return (
    <div className="composer-root min-w-0 shrink-0 px-4 pb-4 pt-1">
      {occupied && (
        <p className="mx-auto mb-2 max-w-3xl break-words px-2 text-center text-xs leading-5 text-amber-200/90">
          此会话正被其他进程占用，当前只读，不能发送。
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="mx-auto mb-2 max-w-3xl break-words px-2 text-center text-xs leading-5 text-amber-200/90"
        >
          {notice}
        </p>
      )}
      {catalogNotice && (
        <p
          role="status"
          className="mx-auto mb-2 max-w-3xl break-words px-2 text-center text-xs leading-5 text-zinc-500"
        >
          {catalogNotice}
        </p>
      )}
      <div className="relative mx-auto min-w-0 max-w-3xl">
      {queueOn && queue.length > 0 && (
        <div className="mb-2 flex min-w-0 flex-col gap-1.5 overflow-x-hidden">
          {queue.map((item) => (
            <div
              key={item.id}
              className={cn(
                "flex min-w-0 items-start gap-2 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/80 px-3 py-2",
                editingId === item.id && "border-indigo-400/80",
              )}
            >
              <div className="min-w-0 flex-1">
                {item.text && (
                  <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm leading-5 text-zinc-200">
                    {item.text}
                  </p>
                )}
                {(item.images ?? []).length > 0 && (
                  <div className="mt-1 flex min-w-0 flex-wrap gap-1 overflow-x-hidden">
                    {(item.images ?? []).map((path) => (
                      <ChatThumb
                        key={path}
                        path={path}
                        name={fileName(path)}
                        className="h-10 w-10 rounded-md object-cover"
                      />
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="rounded-full p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                aria-label="编辑排队消息"
                onClick={(event) => {
                  event.stopPropagation();
                  beginEdit(item);
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                className="rounded-full p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                aria-label="删除排队消息"
                onClick={(event) => {
                  event.stopPropagation();
                  if (editingId === item.id) cancelEdit();
                  void backend.removeQueuedTurn(session.id, item.id).catch((error: unknown) => {
                    useWorkbench.setState({ lastError: String(error) });
                  });
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      {skillOpen && (
        <div
          role="listbox"
          aria-label="技能"
          className="absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 min-w-0 overflow-x-hidden overflow-y-auto rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
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
                  "flex w-full min-w-0 items-baseline gap-3 px-3 py-2 text-left hover:bg-zinc-800",
                  skill === activeSkill && "bg-zinc-800",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  applySkill(skill);
                }}
              >
                <span className="min-w-0 shrink break-all font-mono text-sm text-zinc-100">{`$${skill.mention}`}</span>
                <span className="min-w-0 truncate text-xs text-zinc-500">
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
                "flex w-full min-w-0 items-baseline gap-3 px-3 py-2 text-left hover:bg-zinc-800",
                index === Math.min(slashIndex, slashMatches.length - 1) && "bg-zinc-800",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                applySlash(cmd);
              }}
            >
              <span className="shrink-0 font-mono text-sm text-zinc-100">{cmd.name}</span>
              <span className="min-w-0 truncate text-xs text-zinc-500">{cmd.hint}</span>
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
        className={cn(
          "min-w-0 overflow-hidden rounded-[28px] border border-zinc-700/90 bg-zinc-900 px-3 pb-2.5 pt-3 shadow-lg shadow-black/20 transition-colors focus-within:border-zinc-500",
          dragOver && imagesOn && "border-indigo-400/80",
        )}
        onClick={() => textareaRef.current?.focus()}
        onDragOver={(event) => {
          if (!imagesOn || composerLocked) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          if (!imagesOn || composerLocked) return;
          event.preventDefault();
          setDragOver(false);
          void stageBlobs(Array.from(event.dataTransfer.files));
        }}
      >
        {files.length > 0 && imagesOn && (
          <div className="mb-2 flex min-w-0 flex-wrap gap-2 overflow-x-hidden px-1">
            {files.map((file) => (
              <div key={file.path} className="group relative h-[72px] w-[72px] shrink-0">
                <ChatThumb
                  path={file.path}
                  name={file.name}
                  className="h-[72px] w-[72px] rounded-xl object-cover"
                />
                <button
                  type="button"
                  className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-950/85 text-zinc-100 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  aria-label={`移除 ${file.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeAttachment(session.id, file.path);
                  }}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        {files.length > 0 && !imagesOn && (
          <div className="mb-2 flex min-w-0 flex-wrap gap-1.5 overflow-x-hidden px-1">
            {files.map((file) => (
              <span
                key={file.path}
                title={file.path}
                className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200"
              >
                <span className="min-w-0 truncate">{file.name}</span>
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
          onPaste={(event) => {
            if (!imagesOn || composerLocked) return;
            const blobs = Array.from(event.clipboardData.files);
            if (!blobs.length) return;
            event.preventDefault();
            void stageBlobs(blobs);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && editingId) {
              e.preventDefault();
              cancelEdit();
              return;
            }
            if (skillOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setSkillIndex((current) => stepIndex(current, skillMatches.length, e.key));
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
              setSlashIndex((current) => stepIndex(current, slashMatches.length, e.key));
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
          disabled={composerLocked}
          rows={Math.min(6, Math.max(2, text.split("\n").length))}
          className="max-h-40 w-full min-w-0 max-w-full resize-none overflow-x-hidden bg-transparent px-2 text-sm leading-6 text-zinc-100 placeholder:text-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <button
              ref={plusRef}
              type="button"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="添加附件"
              title="添加附件"
              aria-haspopup={imagesOn ? "menu" : undefined}
              aria-expanded={imagesOn ? menu === "attach" : undefined}
              disabled={composerLocked}
              onClick={(event) => {
                event.stopPropagation();
                if (imagesOn) {
                  setMenu((current) => (current === "attach" ? null : "attach"));
                  return;
                }
                void pickFiles();
              }}
            >
              <Plus className="h-4 w-4" />
            </button>
            <button
              ref={accessRef}
              type="button"
              className={cn(
                "inline-flex h-8 min-w-0 max-w-full items-center gap-1 rounded-full px-2 text-sm hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40",
                mode === "full" ? "text-orange-400" : "text-zinc-300",
              )}
              aria-label="权限"
              aria-haspopup="menu"
              aria-expanded={menu === "access"}
              disabled={composerLocked}
              onClick={(event) => {
                event.stopPropagation();
                setMenu((current) => (current === "access" ? null : "access"));
              }}
            >
              <Shield className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate">{ACCESS_LABELS[mode]}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
            </button>
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            {caps?.supports_tuning && (
            <button
              ref={modelRef}
              type="button"
              className="inline-flex h-8 min-w-0 max-w-52 items-center gap-1 rounded-full px-2 text-sm text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="模型"
              aria-haspopup="menu"
              aria-expanded={menu === "model"}
              disabled={composerLocked || !catalog}
              onClick={(event) => {
                event.stopPropagation();
                setMenu((current) => (current === "model" ? null : "model"));
              }}
            >
              <span className="min-w-0 truncate">{modelButton}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
            </button>
            )}
            {editingId && (
              <button
                type="button"
                className="h-8 shrink-0 rounded-full px-2 text-sm text-zinc-300 hover:bg-zinc-800"
                onClick={(event) => {
                  event.stopPropagation();
                  cancelEdit();
                }}
              >
                取消
              </button>
            )}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                if (stopMode) {
                  void backend.interruptTurn(session.id).catch((error: unknown) => {
                    useWorkbench.setState({ lastError: String(error) });
                  });
                  return;
                }
                submit();
              }}
              disabled={
                stopMode
                  ? false
                  : composerLocked ||
                    !(pendingId
                      ? text.trim()
                      : imagesOn
                        ? text.trim() || files.length > 0
                        : text.trim())
              }
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-950 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"
              title={stopMode ? "停止" : "发送"}
              aria-label={stopMode ? "停止" : "发送"}
            >
              {stopMode ? (
                <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
              ) : (
                <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
              )}
            </button>
          </div>
        </div>
      </div>
      </div>
      {menu === "attach" && imagesOn && (
        <div
          ref={attachMenuRef}
          role="menu"
          aria-label="添加附件"
          className="fixed z-50 w-52 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
          style={{ top: -9999, left: 8 }}
        >
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800"
            onClick={() => void pickFiles()}
          >
            添加照片和文件
          </button>
        </div>
      )}
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
      {menu === "model" && caps?.supports_tuning && (
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
      className="fixed z-50 max-h-80 w-72 overflow-x-hidden overflow-y-auto rounded-xl border border-zinc-700/80 bg-zinc-900 py-1 shadow-xl shadow-black/50"
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
            <span className="block break-words text-sm text-zinc-100">{model.label}</span>
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
