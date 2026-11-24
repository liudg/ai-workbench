import { useCallback, useEffect, useMemo, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAgentInstances, useAgentProfiles } from "@/features/agents";
import { daemon, OFFLINE_MESSAGE } from "@/lib/daemon";
import { userFacingMessage } from "@/lib/user-facing";
import { cn } from "@/lib/utils";
import type { TextGenHttpProtocol, TextGenMode, TextGenSettings } from "@/types";
import {
  createTextGenDraft,
  filterTextGenCapableInstances,
  textGenDraftToSettings,
  updateTextGenApiKey,
  updateTextGenBaseUrl,
  type TextGenFormDraft,
} from "./instance-form";

const selectClass =
  "flex h-9 w-full rounded-lg border border-wb-border-strong bg-wb-input px-3 py-1 text-sm text-wb-fg outline-none transition-colors focus-visible:border-wb-accent focus-visible:ring-2 focus-visible:ring-wb-accent-soft disabled:cursor-not-allowed disabled:opacity-50";

const MODE_OPTIONS: readonly { id: TextGenMode; label: string; hint: string }[] = [
  {
    id: "auto",
    label: "自动复用本机 CLI（推荐）",
    hint: "优先复用当前会话或已就绪的 CLI 实例，无痕禁用插件与 MCP 并自动挑选轻量模型。",
  },
  {
    id: "cli",
    label: "指定 CLI 实例",
    hint: "固定使用指定的本机 CLI 实例执行标题、分支名与提交说明生成。",
  },
  {
    id: "http",
    label: "自定义 HTTP 接口",
    hint: "直连 OpenAI 或 Anthropic 兼容的 HTTP 接口。",
  },
];

const PROTOCOL_OPTIONS: readonly { id: TextGenHttpProtocol; label: string }[] = [
  { id: "openAi", label: "OpenAI 兼容" },
  { id: "anthropic", label: "Anthropic 兼容" },
];

export function TextGenSettingsSection() {
  const instances = useAgentInstances();
  const profiles = useAgentProfiles();
  const capableInstances = useMemo(
    () => filterTextGenCapableInstances(instances, profiles),
    [instances, profiles],
  );

  const [draft, setDraft] = useState<TextGenFormDraft>(() => createTextGenDraft());
  const [lastSavedSettings, setLastSavedSettings] = useState<TextGenSettings>(() =>
    textGenDraftToSettings(createTextGenDraft()),
  );
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    let alive = true;
    daemon
      .call<TextGenSettings>("settings.textGen")
      .then((res) => {
        if (!alive) return;
        const nextDraft = createTextGenDraft(res);
        setDraft(nextDraft);
        setLastSavedSettings(textGenDraftToSettings(nextDraft));
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        const msg = userFacingMessage(err);
        if (msg && !msg.includes(OFFLINE_MESSAGE) && !msg.includes("样例页")) {
          setError(msg);
        }
        setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!savedNotice) return;
    const timer = window.setTimeout(() => setSavedNotice(false), 2000);
    return () => window.clearTimeout(timer);
  }, [savedNotice]);

  const persist = useCallback(async (nextDraft: TextGenFormDraft) => {
    setBusy(true);
    setError(null);
    setSavedNotice(false);
    try {
      const payload = textGenDraftToSettings(nextDraft);
      const saved = await daemon.call<TextGenSettings>("settings.setTextGen", { ...payload });
      const savedDraft = createTextGenDraft(saved);
      setDraft(savedDraft);
      setLastSavedSettings(textGenDraftToSettings(savedDraft));
      setShowKey(false);
      setSavedNotice(true);
    } catch (err) {
      setError(userFacingMessage(err) ?? "保存轻量文本生成设置失败");
    } finally {
      setBusy(false);
    }
  }, []);

  const toggleAutoTitle = useCallback(
    async (checked: boolean) => {
      const previousAutoTitle = lastSavedSettings.autoTitle;
      setDraft((prev) => ({ ...prev, autoTitle: checked }));
      setBusy(true);
      setError(null);
      setSavedNotice(false);
      try {
        const payload: TextGenSettings = { ...lastSavedSettings, autoTitle: checked };
        const saved = await daemon.call<TextGenSettings>("settings.setTextGen", { ...payload });
        const cleanSaved = textGenDraftToSettings(createTextGenDraft(saved));
        setLastSavedSettings(cleanSaved);
        setDraft((prev) => ({ ...prev, autoTitle: cleanSaved.autoTitle }));
        setSavedNotice(true);
      } catch (err) {
        setDraft((prev) => ({ ...prev, autoTitle: previousAutoTitle }));
        setError(userFacingMessage(err) ?? "保存轻量文本生成设置失败");
      } finally {
        setBusy(false);
      }
    },
    [lastSavedSettings],
  );

  const missingConfiguredInstance =
    Boolean(draft.instanceId) && !capableInstances.some((inst) => inst.id === draft.instanceId);

  return (
    <section data-settings-panel="text-gen" className="mt-10">
      <h2 className="text-base font-semibold text-wb-fg">轻量文本生成</h2>
      <p className="mt-1 max-w-lg text-sm leading-6 text-wb-fg-2">
        用于会话标题总结、语义化分支命名与 Git 提交说明，独立于主对话上下文运行。
      </p>

      <div className="mt-4 divide-y divide-wb-border rounded-xl border border-wb-border bg-wb-elev">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm text-wb-fg">首条消息后自动生成会话标题</div>
            <div className="mt-0.5 text-xs leading-5 text-wb-fg-3">
              异步总结首条提问；手动重命名过的会话不会被覆盖。
            </div>
          </div>
          <Switch
            data-textgen-auto-title=""
            aria-label="首条消息后自动生成会话标题"
            checked={draft.autoTitle}
            disabled={busy || !loaded}
            onCheckedChange={(checked) => {
              void toggleAutoTitle(checked);
            }}
          />
        </div>

        <div className="space-y-4 px-4 py-4">
          <div>
            <div className="text-xs font-medium text-wb-fg-2">生成通道</div>
            <div
              className="mt-2 space-y-1.5"
              role="radiogroup"
              aria-label="轻量文本生成模式"
            >
              {MODE_OPTIONS.map((option) => {
                const active = draft.mode === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    data-textgen-mode={option.id}
                    disabled={busy || !loaded}
                    onClick={() => setDraft((prev) => ({ ...prev, mode: option.id }))}
                    className={cn(
                      "flex w-full flex-col rounded-lg border px-3 py-2 text-left transition-colors",
                      active
                        ? "border-wb-accent bg-wb-accent-soft"
                        : "border-wb-border bg-wb-surface/70 hover:border-wb-border-strong hover:bg-wb-hover",
                    )}
                  >
                    <span className="text-xs font-medium text-wb-fg">{option.label}</span>
                    <span className="mt-0.5 text-[11px] leading-4 text-wb-fg-3">
                      {option.hint}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {draft.mode === "auto" || draft.mode === "cli" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium text-wb-fg-2">
                {draft.mode === "cli" ? "指定 CLI 实例" : "首选兜底实例（可选）"}
                <select
                  data-textgen-instance=""
                  className={cn(selectClass, "mt-1")}
                  value={draft.instanceId}
                  disabled={busy || !loaded}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, instanceId: event.target.value }))
                  }
                >
                  <option value="">
                    {draft.mode === "cli"
                      ? "自动选择支持文本生成的实例"
                      : "优先复用当前会话实例"}
                  </option>
                  {missingConfiguredInstance ? (
                    <option value={draft.instanceId}>
                      {draft.instanceId}（不可用或已停用）
                    </option>
                  ) : null}
                  {capableInstances.map((inst) => (
                    <option key={inst.id} value={inst.id}>
                      {inst.displayName}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-xs font-medium text-wb-fg-2">
                轻量模型名称（可选）
                <Input
                  data-textgen-model=""
                  className="mt-1 font-mono text-xs"
                  placeholder="留空自动选择轻量模型"
                  value={draft.model}
                  disabled={busy || !loaded}
                  onChange={(event) =>
                    setDraft((prev) => ({ ...prev, model: event.target.value }))
                  }
                />
              </label>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="text-xs font-medium text-wb-fg-2">接口协议</div>
                <div className="mt-1.5 flex flex-wrap gap-2" role="group" aria-label="HTTP 协议">
                  {PROTOCOL_OPTIONS.map((opt) => {
                    const active = draft.protocol === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        data-textgen-protocol={opt.id}
                        aria-pressed={active}
                        disabled={busy || !loaded}
                        onClick={() => setDraft((prev) => ({ ...prev, protocol: opt.id }))}
                        className={cn(
                          "rounded-lg border px-3 py-1.5 text-xs transition-colors",
                          active
                            ? "border-wb-accent bg-wb-accent-soft font-medium text-wb-fg"
                            : "border-wb-border bg-wb-surface text-wb-fg-2 hover:bg-wb-hover",
                        )}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-xs font-medium text-wb-fg-2">
                  Base URL
                  <Input
                    data-textgen-base-url=""
                    className="mt-1 font-mono text-xs"
                    placeholder={
                      draft.protocol === "anthropic"
                        ? "https://api.anthropic.com"
                        : "https://api.openai.com/v1"
                    }
                    value={draft.baseUrl}
                    disabled={busy || !loaded}
                    onChange={(event) =>
                      setDraft((prev) => updateTextGenBaseUrl(prev, event.target.value))
                    }
                  />
                </label>

                <label className="block text-xs font-medium text-wb-fg-2">
                  模型名称
                  <Input
                    data-textgen-http-model=""
                    className="mt-1 font-mono text-xs"
                    placeholder="claude-haiku-4-5 / gpt-4o-mini"
                    value={draft.httpModel}
                    disabled={busy || !loaded}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, httpModel: event.target.value }))
                    }
                  />
                </label>
              </div>

              <label className="block text-xs font-medium text-wb-fg-2">
                API Key
                <div className="mt-1 flex gap-2">
                  <Input
                    data-textgen-api-key=""
                    type={!showKey || draft.apiKeyRedacted ? "password" : "text"}
                    className="font-mono text-xs"
                    placeholder={draft.apiKeyRedacted ? "已保存密钥（输入新值覆盖）" : "sk-..."}
                    value={draft.apiKey}
                    disabled={busy || !loaded}
                    onChange={(event) =>
                      setDraft((prev) => updateTextGenApiKey(prev, event.target.value))
                    }
                  />
                  {!draft.apiKeyRedacted ? (
                    <button
                      type="button"
                      aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                      disabled={busy || !loaded}
                      onClick={() => setShowKey((prev) => !prev)}
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-wb-border bg-wb-surface text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg"
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  ) : null}
                </div>
              </label>
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            {savedNotice ? (
              <span role="status" className="text-xs text-wb-ok">
                已保存
              </span>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-textgen-save=""
              disabled={busy || !loaded}
              onClick={() => void persist(draft)}
            >
              {busy ? "保存中…" : "保存配置"}
            </Button>
          </div>
        </div>
      </div>

      {error ? (
        <p className="mt-3 text-sm text-wb-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
