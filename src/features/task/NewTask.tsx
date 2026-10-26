import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, ChevronDown, FolderGit2, GitBranch, Shield } from "lucide-react";

import { AccessMenu } from "@/features/chat/composer/AccessMenu";
import {
  addWritableRoot,
  buttonLabel,
  extrasAllowed,
  removeWritableRoot,
  sandboxFromMenu,
  selectPreset,
  selectProfile,
  setNetwork,
} from "@/features/chat/composer/access";
import { ComposerInput } from "@/features/chat/composer/ComposerInput";
import { useComposerMenu } from "@/features/chat/composer/useComposerMenu";
import { isImeKey } from "@/features/chat/keyboard";
import type { CreateTaskInput, TaskEntry } from "@/features/tasks";
import { pickFolder } from "@/lib/native/pick-folder";
import { cn } from "@/lib/utils";
import { emptySandbox, type AccessMode, type AgentKind, type PermissionMenu, type SessionSandbox } from "@/types";
import { draftPermissionMenu } from "./task-backend";

const pill =
  "inline-flex h-8 min-w-0 items-center gap-1 rounded-full px-2.5 text-sm text-[#cfcfcf] hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40";

/** 新任务：写下要做什么，选在主目录还是新工作树里做。 */
export function NewTask({
  projectId,
  projectName,
  agent,
  defaultAccess,
  onCreate,
}: {
  projectId: string;
  projectName: string;
  agent: AgentKind;
  /** 这个 Agent 新建会话的默认权限档。菜单里没有选中项时用它。 */
  defaultAccess: string | null | undefined;
  onCreate: (input: CreateTaskInput) => Promise<TaskEntry | null>;
}) {
  const [text, setText] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [permissionMenu, setPermissionMenu] = useState<PermissionMenu | null>(null);
  const [sandbox, setSandbox] = useState<SessionSandbox | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const accessRef = useRef<HTMLButtonElement>(null);
  const accessMenuRef = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useComposerMenu(menuOpen, accessRef, accessMenuRef, closeMenu);

  useEffect(() => {
    let cancelled = false;
    void draftPermissionMenu(agent)
      .then((menu) => {
        if (cancelled) return;
        setPermissionMenu(menu);
        const fallback = menu.presets.find((preset) => preset.id === defaultAccess);
        setSandbox(sandboxFromMenu(menu) ?? (fallback ? emptySandbox(fallback.id as AccessMode) : null));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agent, defaultAccess]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [projectId]);

  const current = (): SessionSandbox =>
    sandbox ?? { mode: "full", networkAccess: false, writableRoots: [], profileId: "" };
  const canSend = Boolean(text.trim()) && !creating;

  const submit = async () => {
    if (!canSend) return;
    setCreating(true);
    const created = await onCreate({
      projectId,
      prompt: text,
      images: [],
      worktree,
      options: sandbox ? { access: { ...sandbox } } : {},
    });
    setCreating(false);
    if (created) setText("");
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center px-6">
      <div className="composer-root relative w-full max-w-[760px]">
        <h2 className="mb-4 text-center text-[20px] font-medium text-[#e8e8e8]">在 {projectName} 里做什么？</h2>
        <div
          className="min-w-0 rounded-[18px] border border-[#2a2a2a] bg-[#171717] transition-colors focus-within:border-[#3a3a3a]"
          onClick={() => textareaRef.current?.focus()}
        >
          <div className="min-w-0 overflow-hidden px-3 pt-3">
            <ComposerInput
              text={text}
              placeholder="描述这个任务"
              disabled={creating}
              textareaRef={textareaRef}
              onChange={(value) => setText(value)}
              onCaret={() => {}}
              onPaste={() => {}}
              onKeyDown={(event) => {
                if (isImeKey({ composing: event.nativeEvent.isComposing, keyCode: event.keyCode })) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1 px-3 pb-2.5">
            <button
              type="button"
              className={pill}
              aria-pressed={worktree}
              title={worktree ? "在新的工作树和分支里做，不碰主目录" : "直接在项目主目录里做"}
              disabled={creating}
              onClick={(event) => {
                event.stopPropagation();
                setWorktree((value) => !value);
              }}
            >
              {worktree ? <GitBranch className="h-4 w-4 shrink-0" /> : <FolderGit2 className="h-4 w-4 shrink-0" />}
              <span className="truncate">{worktree ? "新工作树" : "主目录"}</span>
            </button>
            <button
              ref={accessRef}
              type="button"
              className={pill}
              aria-label="权限"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={creating || !permissionMenu}
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen((open) => !open);
              }}
            >
              <Shield className="h-4 w-4 shrink-0" />
              <span className="truncate">{buttonLabel(sandbox, permissionMenu)}</span>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
            </button>
            <span className="flex-1" />
            <button
              type="button"
              aria-label="开始"
              title="开始"
              disabled={!canSend}
              onClick={(event) => {
                event.stopPropagation();
                void submit();
              }}
              className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[#3a3a3a] bg-[#2c2c2c] text-[#e8e8e8] transition-colors hover:bg-[#3a3a3a]",
                "disabled:cursor-not-allowed disabled:border-[#2a2a2a] disabled:bg-[#242424] disabled:text-[#555]",
              )}
            >
              <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
            </button>
          </div>
        </div>
        {menuOpen && (
          <AccessMenu
            menuRef={accessMenuRef}
            sandbox={sandbox}
            menu={permissionMenu}
            showNetwork={Boolean(permissionMenu?.network_access) && extrasAllowed(permissionMenu, sandbox)}
            showWritable={Boolean(permissionMenu?.writable_roots) && extrasAllowed(permissionMenu, sandbox)}
            onPreset={(mode) => setSandbox(selectPreset(current(), mode))}
            onProfile={(id) => setSandbox(selectProfile(current(), id))}
            onNetwork={(enabled) => setSandbox(setNetwork(current(), enabled))}
            onAddDir={() => {
              void pickFolder("添加可写目录").then((path) => {
                if (path) setSandbox(addWritableRoot(current(), path));
              });
            }}
            onRemoveDir={(path) => setSandbox(removeWritableRoot(current(), path))}
          />
        )}
      </div>
    </div>
  );
}
