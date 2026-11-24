import { useEffect, useState } from "react";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { UpsertInstanceInput } from "@/features/agents";
import { userFacingMessage } from "@/lib/user-facing";
import { cn } from "@/lib/utils";
import type { AgentCapabilities, AgentInstance, AgentKind } from "@/types";
import {
  ACCENT_COLOR_PRESETS,
  availableIsolationModes,
  createEmptyEnvVarDraft,
  createInstanceFormDraft,
  draftToUpsertInput,
  toggleEnvVarSensitive,
  updateEnvVarName,
  updateEnvVarValue,
  type InstanceFormDraft,
} from "./instance-form";

const textareaClass =
  "min-h-[72px] w-full rounded-lg border border-wb-border-strong bg-wb-input px-3 py-2 text-sm text-wb-fg outline-none transition-colors placeholder:text-wb-dim focus-visible:border-wb-accent focus-visible:ring-2 focus-visible:ring-wb-accent-soft disabled:cursor-not-allowed disabled:opacity-50";

export function InstanceFormDialog({
  open,
  kind,
  agentLabel,
  instance,
  capabilities,
  onClose,
  onSubmit,
}: {
  open: boolean;
  kind: AgentKind;
  agentLabel: string;
  instance: AgentInstance | null;
  capabilities: AgentCapabilities | undefined;
  onClose: () => void;
  onSubmit: (input: UpsertInstanceInput) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<InstanceFormDraft>(() =>
    createInstanceFormDraft({
      kind,
      instance,
      capabilities,
    }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealedRows, setRevealedRows] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    setDraft(
      createInstanceFormDraft({
        kind,
        instance,
        capabilities,
      }),
    );
    setBusy(false);
    setError(null);
    setRevealedRows({});
  }, [open, kind, instance, capabilities]);

  const modes = availableIsolationModes(capabilities);
  const editing = Boolean(instance);

  const handleSave = async () => {
    if (!draft.displayName.trim()) {
      setError("请输入实例显示名称");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(draftToUpsertInput(draft, capabilities));
      onClose();
    } catch (err) {
      setError(userFacingMessage(err) ?? "保存实例失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onClose();
      }}
    >
      <DialogContent
        data-instance-dialog={editing ? "edit" : "create"}
        className="max-h-[85vh] max-w-lg overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>
            {editing ? `编辑实例 · ${instance?.displayName ?? agentLabel}` : `新建 ${agentLabel} 实例`}
          </DialogTitle>
          <DialogDescription>
            配置独立账号目录、自定义网关环境变量或启动参数，各实例的模型与额度缓存互不混用。
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          <div>
            <label className="block text-xs font-medium text-wb-fg-2">
              实例名称
              <Input
                data-instance-name=""
                className="mt-1"
                placeholder={`例如：${agentLabel}（工作账号）`}
                value={draft.displayName}
                disabled={busy}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, displayName: event.target.value }))
                }
              />
            </label>
          </div>

          <div>
            <div className="text-xs font-medium text-wb-fg-2">区分色标</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-instance-color-preset="none"
                aria-pressed={!draft.accentColor.trim()}
                disabled={busy}
                onClick={() => setDraft((prev) => ({ ...prev, accentColor: "" }))}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs transition-colors",
                  !draft.accentColor.trim()
                    ? "border-wb-accent bg-wb-accent-soft text-wb-fg"
                    : "border-wb-border bg-wb-elev text-wb-fg-2 hover:bg-wb-hover",
                )}
              >
                无
              </button>
              {ACCENT_COLOR_PRESETS.map((preset) => {
                const selected = draft.accentColor.toLowerCase() === preset.value.toLowerCase();
                return (
                  <button
                    key={preset.value}
                    type="button"
                    title={preset.label}
                    aria-label={preset.label}
                    aria-pressed={selected}
                    data-instance-color-preset={preset.value}
                    disabled={busy}
                    onClick={() => setDraft((prev) => ({ ...prev, accentColor: preset.value }))}
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded-full border transition-transform",
                      selected
                        ? "scale-110 border-wb-fg ring-2 ring-wb-accent-soft"
                        : "border-wb-border hover:scale-105",
                    )}
                  >
                    <span
                      className="h-4 w-4 rounded-full"
                      style={{ backgroundColor: preset.value }}
                    />
                  </button>
                );
              })}
              <Input
                data-instance-accent=""
                aria-label="自定义十六进制色值"
                placeholder="#3b82f6"
                value={draft.accentColor}
                disabled={busy}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, accentColor: event.target.value }))
                }
                className="h-7 w-28 font-mono text-xs"
              />
            </div>
          </div>

          <div>
            <div className="text-xs font-medium text-wb-fg-2">配置目录隔离模式</div>
            <div className="mt-1.5 space-y-1.5" role="radiogroup" aria-label="配置目录隔离模式">
              {modes.map((option) => {
                const active = draft.isolationMode === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    data-instance-isolation={option.id}
                    disabled={busy}
                    onClick={() => setDraft((prev) => ({ ...prev, isolationMode: option.id }))}
                    className={cn(
                      "flex w-full flex-col rounded-lg border px-3 py-2 text-left transition-colors",
                      active
                        ? "border-wb-accent bg-wb-accent-soft"
                        : "border-wb-border bg-wb-elev hover:border-wb-border-strong hover:bg-wb-hover",
                    )}
                  >
                    <span className="text-xs font-medium text-wb-fg">{option.label}</span>
                    <span className="mt-0.5 text-[11px] leading-4 text-wb-fg-3">{option.hint}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {draft.isolationMode !== "hostDefault" ? (
            <div className="space-y-3">
              <label className="block text-xs font-medium text-wb-fg-2">
                自定义实例目录（可选）
                <Input
                  data-instance-home-path=""
                  className="mt-1 font-mono text-xs"
                  placeholder="留空由工作台在数据目录下自动托管"
                  value={draft.homePath}
                  disabled={busy}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, homePath: event.target.value }))
                  }
                />
              </label>
              {draft.isolationMode === "shadowHome" && capabilities?.supports_shadow_home ? (
                <label className="block text-xs font-medium text-wb-fg-2">
                  共享源主目录（可选）
                  <Input
                    data-instance-shared-home-path=""
                    className="mt-1 font-mono text-xs"
                    placeholder="留空默认共享宿主主目录"
                    value={draft.sharedHomePath}
                    disabled={busy}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, sharedHomePath: event.target.value }))
                    }
                  />
                </label>
              ) : null}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3">
            <label className="block text-xs font-medium text-wb-fg-2">
              可执行文件路径（可选）
              <Input
                data-instance-binary-path=""
                className="mt-1 font-mono text-xs"
                placeholder="留空使用系统 PATH 中的默认命令"
                value={draft.binaryPath}
                disabled={busy}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, binaryPath: event.target.value }))
                }
              />
            </label>

            <label className="block text-xs font-medium text-wb-fg-2">
              附加启动参数（可选，每行一个或单行空格分隔）
              <textarea
                data-instance-launch-args=""
                className={cn(textareaClass, "mt-1 font-mono text-xs")}
                placeholder="--profile work"
                value={draft.launchArgsText}
                disabled={busy}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, launchArgsText: event.target.value }))
                }
              />
            </label>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-wb-fg-2">环境变量覆盖</span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                data-instance-env-add=""
                disabled={busy}
                onClick={() =>
                  setDraft((prev) => ({
                    ...prev,
                    environment: [...prev.environment, createEmptyEnvVarDraft()],
                  }))
                }
              >
                <Plus className="h-3 w-3" />
                添加变量
              </Button>
            </div>

            {draft.environment.length > 0 ? (
              <div className="mt-2 space-y-2">
                {draft.environment.map((row, index) => {
                  const revealed = Boolean(revealedRows[row.id]);
                  const masked = row.sensitive && !revealed;
                  return (
                    <div
                      key={row.id}
                      data-instance-env-row={index}
                      className="rounded-lg border border-wb-border bg-wb-elev p-2.5"
                    >
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] gap-2">
                        <Input
                          data-instance-env-name={index}
                          aria-label="环境变量名"
                          placeholder="变量名"
                          value={row.name}
                          disabled={busy}
                          className="h-8 font-mono text-xs"
                          onChange={(event) =>
                            setDraft((prev) => ({
                              ...prev,
                              environment: prev.environment.map((item) =>
                                item.id === row.id ? updateEnvVarName(item, event.target.value) : item,
                              ),
                            }))
                          }
                        />
                        <div className="flex gap-1">
                          <Input
                            data-instance-env-value={index}
                            aria-label="环境变量值"
                            type={masked ? "password" : "text"}
                            placeholder={row.valueRedacted ? "已保存密钥（输入新值覆盖）" : "变量值"}
                            value={row.value}
                            disabled={busy}
                            className="h-8 font-mono text-xs"
                            onChange={(event) =>
                              setDraft((prev) => ({
                                ...prev,
                                environment: prev.environment.map((item) =>
                                  item.id === row.id ? updateEnvVarValue(item, event.target.value) : item,
                                ),
                              }))
                            }
                          />
                          {row.sensitive && !row.valueRedacted ? (
                            <button
                              type="button"
                              aria-label={revealed ? "隐藏变量值" : "显示变量值"}
                              disabled={busy}
                              onClick={() =>
                                setRevealedRows((prev) => ({ ...prev, [row.id]: !prev[row.id] }))
                              }
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-wb-border bg-wb-surface text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg"
                            >
                              {revealed ? (
                                <EyeOff className="h-3.5 w-3.5" />
                              ) : (
                                <Eye className="h-3.5 w-3.5" />
                              )}
                            </button>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          data-instance-env-remove={index}
                          aria-label="移除环境变量"
                          disabled={busy}
                          onClick={() => {
                            setDraft((prev) => ({
                              ...prev,
                              environment: prev.environment.filter((item) => item.id !== row.id),
                            }));
                            setRevealedRows((prev) => {
                              if (!(row.id in prev)) return prev;
                              const next = { ...prev };
                              delete next[row.id];
                              return next;
                            });
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-lg text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-danger"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <div className="mt-2 flex items-center justify-between text-xs text-wb-fg-3">
                        <span>
                          {row.valueRedacted
                            ? "已加密保存，未修改时自动保留原密钥"
                            : "敏感变量在界面脱敏显示"}
                        </span>
                        <label className="inline-flex items-center gap-1.5 text-wb-fg-2">
                          <span>敏感密钥</span>
                          <Switch
                            size="sm"
                            data-instance-env-sensitive={index}
                            aria-label="敏感密钥"
                            checked={row.sensitive}
                            disabled={busy}
                            onCheckedChange={(checked) =>
                              setDraft((prev) => ({
                                ...prev,
                                environment: prev.environment.map((item) =>
                                  item.id === row.id ? toggleEnvVarSensitive(item, checked) : item,
                                ),
                              }))
                            }
                          />
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>

          {error ? (
            <p role="alert" data-instance-form-error="" className="text-xs text-wb-danger">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" size="sm" data-instance-save="" disabled={busy}>
              {busy ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
