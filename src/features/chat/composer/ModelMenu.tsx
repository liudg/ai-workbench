// 模型和推理强度。左边的 Agent / 实例竖栏照 t3code `apps/web/src/components/chat/ModelPickerSidebar.tsx`，
// 换不了 Agent 的会话只剩当前实例照 `apps/web/src/components/chat/ModelPickerContent.tsx` 的 `lockedProvider`。

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Check, ChevronLeft, ChevronRight, RotateCcw, Zap } from "lucide-react";

import { userFacingMessage } from "@/lib/user-facing";
import { cn } from "@/lib/utils";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { AgentKind, AgentModelOption, ReasoningEffortOption } from "@/types";
import type { AgentChoice, AgentOption } from "./host";
import { effortChoiceLabel, effortDisplay } from "./effort-label";
import {
  explicitOptionInstanceId,
  invokeSelectAgent,
  modelSections,
  optionAccentColor,
  optionInstanceKey,
  selectedInstanceKey,
  shouldShowInstanceStrip,
  sliderEfforts,
  snapEffortIndex,
} from "./model-picker";

export function ModelMenu({
  menuRef,
  agents,
  models,
  modelId,
  modelLabel,
  effortId,
  fastOn,
  fastAvailable,
  fastTip,
  canReset,
  onModel,
  onEffort,
  onFast,
  onReset,
}: {
  menuRef: RefObject<HTMLDivElement>;
  agents: AgentChoice | null;
  models: AgentModelOption[];
  modelId?: string;
  modelLabel?: string;
  effortId?: string;
  fastOn: boolean;
  fastAvailable: boolean;
  fastTip: string;
  canReset: boolean;
  onModel: (model: AgentModelOption) => void;
  onEffort: (effort: string) => void;
  onFast: (enabled: boolean) => void;
  onReset: () => void;
}) {
  const [panel, setPanel] = useState<"effort" | "models">(models.length > 0 ? "effort" : "models");
  const [liveEffort, setLiveEffort] = useState<string | null>(null);
  const shownEffort = liveEffort ?? effortId;
  const current = models.find((item) => item.id === modelId);
  const effortLabel = effortDisplay(current, shownEffort);
  const hasEfforts = sliderEfforts(current).length > 0;
  return (
    <div
      ref={menuRef}
      role="dialog"
      aria-label={panel === "models" ? DESKTOP_ZH.selectModel : "推理强度"}
      data-intensity-popover
      data-intensity-panel={panel}
      className={cn(
        "wb-modal fixed z-50 select-none text-xs transition-[width] duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
        panel === "models" ? "w-[324px]" : "w-[276px]",
      )}
      style={{ top: -9999, left: 8 }}
    >
      {panel === "models" ? (
        <ModelPanel
          agents={agents}
          models={models}
          modelId={modelId}
          backLabel={hasEfforts ? "返回强度" : "返回"}
          onBack={models.length > 0 ? () => setPanel("effort") : null}
          onPick={(model) => {
            setLiveEffort(null);
            onModel(model);
            setPanel("effort");
          }}
        />
      ) : (
        <div className="p-2.5">
          <div className="flex items-center justify-between gap-1">
            {fastAvailable ? (
              <Tip text={fastTip} align="start">
                <button
                  type="button"
                  data-fast-toggle
                  data-fast-tip={fastTip || undefined}
                  aria-pressed={fastOn}
                  aria-label={fastTip || "快速"}
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-wb-hover",
                    fastOn ? "text-wb-accent" : "text-wb-fg-2",
                  )}
                  onClick={() => onFast(!fastOn)}
                >
                  <Zap className={cn("h-3.5 w-3.5", fastOn && "fill-current")} />
                </button>
              </Tip>
            ) : (
              <span className="h-7 w-7 shrink-0" />
            )}
            <button
              type="button"
              data-model-trigger
              className="flex min-w-0 flex-1 flex-col items-center justify-center rounded-xl bg-wb-hover px-2 py-1 text-center transition-opacity hover:opacity-85"
              aria-label={DESKTOP_ZH.selectModel}
              aria-haspopup="listbox"
              onClick={() => setPanel("models")}
            >
              {hasEfforts ? (
                <span data-effort-label className="block max-w-full whitespace-nowrap text-sm font-semibold leading-tight text-wb-accent">
                  {effortLabel || DESKTOP_ZH.selectEffort}
                </span>
              ) : null}
              <span
                className={
                  hasEfforts
                    ? "mt-0.5 inline-flex max-w-full items-center gap-0.5 text-xs text-wb-fg-2"
                    : "inline-flex max-w-full items-center gap-0.5 text-sm font-semibold leading-tight text-wb-accent"
                }
              >
                <span className="truncate">{modelLabel || current?.label || DESKTOP_ZH.selectModel}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              </span>
            </button>
            <Tip text={DESKTOP_ZH.resetDefault} align="end">
              <button
                type="button"
                data-reset-tuning
                className="flex h-7 w-7 items-center justify-center rounded-lg text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-fg disabled:opacity-40"
                aria-label={DESKTOP_ZH.resetDefault}
                disabled={!canReset}
                onClick={() => {
                  setLiveEffort(null);
                  onReset();
                }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </Tip>
          </div>
          <EffortSlider
            efforts={sliderEfforts(current)}
            effortId={shownEffort}
            onLive={setLiveEffort}
            onEffort={onEffort}
          />
        </div>
      )}
    </div>
  );
}

function Tip({
  text,
  align,
  children,
}: {
  text: string;
  align: "start" | "end";
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return children;
  return (
    <span
      className="relative inline-flex shrink-0"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      <span
        role="tooltip"
        data-hover-tip={text}
        className={cn(
          "wb-tooltip pointer-events-none absolute bottom-[calc(100%+6px)] z-10 whitespace-nowrap rounded-md px-2 py-1 text-xs leading-4",
          align === "start" ? "left-0" : "right-0",
          open ? "block" : "hidden",
        )}
      >
        {text}
      </span>
    </span>
  );
}

function EffortSlider({
  efforts,
  effortId,
  onLive,
  onEffort,
}: {
  efforts: ReasoningEffortOption[];
  effortId?: string;
  onLive: (effort: string | null) => void;
  onEffort: (effort: string) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const committed = useRef(effortId);
  if (!dragging.current) committed.current = effortId;
  if (efforts.length === 0) return null;
  const selected = efforts.findIndex((effort) => effort.id === effortId);
  const valueText = effortChoiceLabel(efforts.find((effort) => effort.id === effortId)) || effortId;
  const count = efforts.length;
  const percent = selected < 0 || count <= 1 ? 0 : (selected / (count - 1)) * 100;

  const commit = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const index = snapEffortIndex(event.clientX, rect.left, rect.width, count);
    const id = efforts[index]?.id;
    if (!id) return;
    onLive(id);
    if (id === committed.current) return;
    committed.current = id;
    onEffort(id);
  };

  return (
    <div
      ref={trackRef}
      data-effort-slider
      role="slider"
      tabIndex={0}
      aria-label="推理强度"
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.max(count - 1, 0)}
      aria-valuenow={Math.max(selected, 0)}
      aria-valuetext={valueText}
      className="relative mx-1 mt-2 h-6 cursor-pointer touch-none"
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        commit(event);
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        commit(event);
      }}
      onPointerUp={() => {
        dragging.current = false;
        onLive(null);
      }}
      onPointerCancel={() => {
        dragging.current = false;
        onLive(null);
      }}
      onKeyDown={(event) => {
        const next =
          event.key === "ArrowRight" || event.key === "ArrowUp"
            ? Math.min(Math.max(selected, 0) + 1, count - 1)
            : event.key === "ArrowLeft" || event.key === "ArrowDown"
              ? Math.max((selected < 0 ? 0 : selected) - 1, 0)
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? count - 1
                  : null;
        if (next === null) return;
        event.preventDefault();
        const id = efforts[next]?.id;
        if (id && id !== effortId) onEffort(id);
      }}
    >
      <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-wb-active" />
      {selected >= 0 && (
        <div
          className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-wb-accent"
          style={{ width: `${percent}%` }}
        />
      )}
      {efforts.map((effort, index) => {
        const left = count <= 1 ? 0 : (index / (count - 1)) * 100;
        return (
          <span
            key={effort.id}
            data-effort-stop={effort.id}
            className={cn(
              "absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full",
              selected >= 0 && index <= selected ? "bg-wb-accent" : "bg-wb-dim",
            )}
            style={{ left: `${left}%` }}
          />
        );
      })}
      {selected >= 0 && (
        <span
          data-effort-handle
          className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-wb-accent bg-white shadow"
          style={{ left: `${percent}%` }}
        />
      )}
    </div>
  );
}

type RailTarget = {
  kind: AgentKind;
  key: string;
  explicitInstanceId?: string;
};

/** 别的 Agent / 实例的模型：竖栏切过去时按实例 key 读一次。 */
type OtherModels = { key: string; models: AgentModelOption[] | null; error: string | null };

function initialRailTarget(agents: AgentChoice | null): RailTarget | undefined {
  if (!agents) return undefined;
  const key = selectedInstanceKey(agents);
  const matched = agents.options?.find((opt) => optionInstanceKey(opt) === key);
  if (matched) {
    return {
      kind: matched.kind,
      key,
      explicitInstanceId: explicitOptionInstanceId(matched),
    };
  }
  const explicit = agents.selectedInstanceId?.trim() || undefined;
  return { kind: agents.selected, key, explicitInstanceId: explicit };
}

function ModelPanel({
  agents,
  models,
  modelId,
  backLabel,
  onBack,
  onPick,
}: {
  agents: AgentChoice | null;
  models: AgentModelOption[];
  modelId?: string;
  backLabel: string;
  onBack: (() => void) | null;
  onPick: (model: AgentModelOption) => void;
}) {
  const selectedKey = agents ? selectedInstanceKey(agents) : undefined;
  const switcher = agents?.switcher ?? null;
  const [railTarget, setRailTarget] = useState<RailTarget | undefined>(() => initialRailTarget(agents));
  const [syncedKey, setSyncedKey] = useState<string | undefined>(selectedKey);
  if (syncedKey !== selectedKey) {
    setSyncedKey(selectedKey);
    setRailTarget(initialRailTarget(agents));
  }

  const [other, setOther] = useState<OtherModels | null>(null);
  const railKey = railTarget?.key;
  const railKind = railTarget?.kind;
  const railExplicitId = railTarget?.explicitInstanceId;
  const viewingOther = switcher !== null && railKey !== undefined && railKey !== selectedKey;

  // 回合进行中外面会不断给新的 switcher；只在换了竖栏上的实例时重读。
  const loadModels = useRef(switcher?.loadModels);
  loadModels.current = switcher?.loadModels;
  const canSwitch = switcher !== null;
  useEffect(() => {
    if (!canSwitch || !loadModels.current || !railKind || !railKey || railKey === selectedKey) return;
    let cancelled = false;
    setOther({ key: railKey, models: null, error: null });
    const show = (found: AgentModelOption[]) => {
      if (!cancelled) setOther({ key: railKey, models: found, error: null });
    };
    const work =
      railExplicitId !== undefined
        ? loadModels.current(railKind, show, railExplicitId)
        : loadModels.current(railKind, show);
    work.catch((error: unknown) => {
      if (!cancelled) setOther({ key: railKey, models: null, error: userFacingMessage(error) });
    });
    return () => {
      cancelled = true;
    };
  }, [railKind, railKey, railExplicitId, selectedKey, canSwitch]);

  const handleSelectOption = (option: AgentOption) => {
    const explicitId = explicitOptionInstanceId(option);
    const key = optionInstanceKey(option);
    setRailTarget({ kind: option.kind, key, explicitInstanceId: explicitId });
    invokeSelectAgent(agents?.selectAgent, option.kind, explicitId);
  };

  const loaded = other?.key === railKey ? other : null;
  const withRail = Boolean(agents);
  const showStrip = shouldShowInstanceStrip(agents?.options, railKind);
  const sameKindOptions = showStrip
    ? (agents?.options ?? []).filter((opt) => opt.kind === railKind)
    : [];
  const activeOption = (agents?.options ?? []).find((opt) => optionInstanceKey(opt) === railKey);

  const instanceStrip =
    sameKindOptions.length > 0 ? (
      <div
        data-instance-strip=""
        className="flex flex-wrap items-center gap-1 border-b border-wb-border bg-wb-elev/40 px-2.5 py-1.5"
      >
        {sameKindOptions.map((option) => {
          const key = optionInstanceKey(option);
          const active = key === railKey;
          const dotColor = optionAccentColor(option);
          return (
            <button
              key={key}
              type="button"
              data-instance-pill={key}
              aria-pressed={active}
              className={cn(
                "inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-xs transition-colors",
                active
                  ? "wb-menu-active font-medium text-wb-fg"
                  : "text-wb-fg-2 hover:bg-wb-hover hover:text-wb-fg",
              )}
              onClick={() => handleSelectOption(option)}
            >
              {dotColor ? (
                <span
                  data-instance-pill-dot=""
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: dotColor }}
                />
              ) : null}
              <span className="truncate">{option.name}</span>
            </button>
          );
        })}
      </div>
    ) : null;

  const list = viewingOther ? (
    <ModelList
      models={loaded?.models ?? null}
      error={loaded?.error ?? null}
      blocked={switcher?.blocked ?? null}
      withRail={withRail}
      backLabel={backLabel}
      instanceStrip={instanceStrip}
      directSwitchLabel={
        switcher?.onPickAgentOnly && activeOption ? `切换到 ${activeOption.name}` : null
      }
      onDirectSwitch={
        switcher?.onPickAgentOnly && railKind
          ? () => {
              if (railExplicitId !== undefined) switcher.onPickAgentOnly?.(railKind, railExplicitId);
              else switcher.onPickAgentOnly?.(railKind);
            }
          : null
      }
      onBack={onBack}
      onPick={(model) => {
        if (railKind !== undefined) {
          if (railExplicitId !== undefined) switcher?.onPick(railKind, model, railExplicitId);
          else switcher?.onPick(railKind, model);
        }
      }}
    />
  ) : (
    <ModelList
      models={models}
      error={null}
      modelId={modelId}
      withRail={withRail}
      backLabel={backLabel}
      instanceStrip={instanceStrip}
      onBack={onBack}
      onPick={onPick}
    />
  );
  if (!agents) return list;
  return (
    <div className="grid grid-cols-[2.75rem_minmax(0,1fr)]">
      <div
        role="toolbar"
        aria-orientation="vertical"
        aria-label="Agent"
        data-agent-rail
        className="flex flex-col items-center gap-1 border-r border-wb-border p-2"
      >
        {(agents.options ?? []).map((option) => {
          const key = optionInstanceKey(option);
          const active = key === railKey;
          const dotColor = optionAccentColor(option);
          return (
            <button
              key={key}
              type="button"
              title={option.name}
              aria-label={option.name}
              aria-pressed={active}
              data-agent={option.kind}
              data-instance={key}
              className={cn(
                "relative flex h-7 w-7 items-center justify-center rounded-lg transition-colors",
                active ? "wb-menu-active text-wb-fg" : "text-wb-fg-3 hover:bg-wb-hover hover:text-wb-fg",
              )}
              onClick={() => handleSelectOption(option)}
            >
              <SessionAgentIcon identity={option.identity} className="h-4 w-4" />
              {dotColor ? (
                <span
                  data-instance-dot=""
                  aria-hidden
                  className="absolute bottom-0.5 right-0.5 h-2 w-2 rounded-full ring-1 ring-wb-surface"
                  style={{ backgroundColor: dotColor }}
                />
              ) : null}
            </button>
          );
        })}
      </div>
      {list}
    </div>
  );
}

function ModelList({
  models,
  error,
  blocked = null,
  modelId,
  backLabel,
  instanceStrip = null,
  directSwitchLabel = null,
  onDirectSwitch = null,
  onBack,
  onPick,
}: {
  /** null 表示还在读。 */
  models: AgentModelOption[] | null;
  error: string | null;
  /** 有值时模型只能看，顶上写明原因。 */
  blocked?: string | null;
  modelId?: string;
  withRail?: boolean;
  backLabel: string;
  instanceStrip?: ReactNode;
  directSwitchLabel?: string | null;
  onDirectSwitch?: (() => void) | null;
  onBack: (() => void) | null;
  onPick: (model: AgentModelOption) => void;
}) {
  const sections = models ? modelSections(models) : [];
  return (
    <div
      data-model-list
      role="listbox"
      aria-label={DESKTOP_ZH.selectModel}
      className="flex max-h-80 min-w-0 flex-col overflow-hidden text-xs"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-wb-border bg-wb-surface px-3 py-2">
        <span className="text-xs font-semibold text-wb-fg">{DESKTOP_ZH.selectModel}</span>
        {onBack ? (
          <button
            type="button"
            data-back-to-effort=""
            className="inline-flex items-center gap-0.5 rounded-md border border-wb-border bg-wb-elev/70 px-2 py-0.5 text-xs font-medium text-wb-fg-2 transition-colors hover:bg-wb-hover hover:text-wb-fg"
            onClick={onBack}
          >
            <ChevronLeft className="h-3 w-3" aria-hidden="true" />
            {backLabel}
          </button>
        ) : null}
      </div>
      {instanceStrip}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {blocked ? (
          <p data-switch-blocked className="px-2 pb-1 pt-0.5 text-xs text-wb-warn">{blocked}</p>
        ) : null}
        {error ? (
          <p className="break-words px-2 py-2 text-xs text-wb-fg-3">{error}</p>
        ) : models === null ? (
          <p className="px-2 py-2 text-xs text-wb-fg-3">读取模型…</p>
        ) : sections.length === 0 ? (
          <div className="space-y-2 px-2 py-2">
            <p className="text-xs text-wb-fg-3">当前 Agent 没有可选模型</p>
            {!blocked && directSwitchLabel && onDirectSwitch ? (
              <button
                type="button"
                data-switch-instance-direct=""
                className="rounded-lg border border-wb-border bg-wb-elev px-2.5 py-1 text-xs font-medium text-wb-fg transition-colors hover:bg-wb-hover"
                onClick={onDirectSwitch}
              >
                {directSwitchLabel}
              </button>
            ) : null}
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.id} className="space-y-0.5">
              <p className="wb-group-header px-2 pb-1 pt-2 first:pt-1">{section.title}</p>
              {section.models.map((model) => {
                const selected = model.id === modelId;
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={Boolean(blocked)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] leading-5 transition-colors disabled:pointer-events-none disabled:opacity-50",
                      selected ? "wb-menu-active font-medium" : "text-wb-fg hover:bg-wb-hover",
                    )}
                    onClick={() => onPick(model)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{model.label}</span>
                    </span>
                    {selected && <Check className="h-3.5 w-3.5 shrink-0 text-wb-accent-ink" aria-hidden />}
                  </button>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
