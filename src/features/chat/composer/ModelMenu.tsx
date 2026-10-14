import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { Check, ChevronRight, RotateCcw, Zap } from "lucide-react";

import { cn } from "@/lib/utils";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { AgentModelOption, ReasoningEffortOption } from "@/types";
import { effortChoiceLabel, effortDisplay } from "./effort-label";
import { modelSections, sliderEfforts, snapEffortIndex } from "./model-picker";

export function ModelMenu({
  menuRef,
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
  const [panel, setPanel] = useState<"effort" | "models">("effort");
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
      className="fixed z-50 w-[17.5rem] select-none rounded-2xl border border-zinc-700/80 bg-zinc-900 text-zinc-100 shadow-xl shadow-black/50"
      style={{ top: -9999, left: 8 }}
    >
      {panel === "models" ? (
        <ModelList
          models={models}
          modelId={modelId}
          onPick={(model) => {
            setLiveEffort(null);
            onModel(model);
            setPanel("effort");
          }}
        />
      ) : (
        <div className="px-2.5 pb-2 pt-2">
          <div className="flex items-start gap-1">
            {fastAvailable ? (
              <Tip text={fastTip} align="start">
                <button
                  type="button"
                  data-fast-toggle
                  data-fast-tip={fastTip || undefined}
                  aria-pressed={fastOn}
                  aria-label={fastTip || "快速"}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-lg hover:bg-zinc-800",
                    fastOn ? "text-blue-400" : "text-zinc-400",
                  )}
                  onClick={() => onFast(!fastOn)}
                >
                  <Zap className={cn("h-4 w-4", fastOn && "fill-current")} />
                </button>
              </Tip>
            ) : (
              <span className="h-8 w-8 shrink-0" />
            )}
            <button
              type="button"
              data-model-trigger
              className="flex min-w-0 flex-1 flex-col items-center justify-center rounded-xl px-2 py-0.5 hover:bg-zinc-800/70"
              aria-label={DESKTOP_ZH.selectModel}
              aria-haspopup="listbox"
              onClick={() => setPanel("models")}
            >
              {hasEfforts ? (
                <span data-effort-label className="block max-w-full whitespace-nowrap text-lg font-semibold leading-none text-blue-400">
                  {effortLabel || DESKTOP_ZH.selectEffort}
                </span>
              ) : null}
              <span
                className={
                  hasEfforts
                    ? "mt-1.5 inline-flex max-w-full items-center gap-0.5 text-[13px] text-zinc-400"
                    : "inline-flex max-w-full items-center gap-0.5 text-lg font-semibold leading-none text-blue-400"
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
                className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
                aria-label={DESKTOP_ZH.resetDefault}
                disabled={!canReset}
                onClick={() => {
                  setLiveEffort(null);
                  onReset();
                }}
              >
                <RotateCcw className="h-4 w-4" />
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
          "pointer-events-none absolute bottom-[calc(100%+6px)] z-10 whitespace-nowrap rounded-md bg-zinc-800 px-2 py-1 text-[11px] leading-4 text-zinc-100 shadow-lg ring-1 ring-zinc-700",
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
      <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-zinc-700" />
      {selected >= 0 && (
        <div
          className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-blue-400"
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
              selected >= 0 && index <= selected ? "bg-blue-400" : "bg-zinc-500",
            )}
            style={{ left: `${left}%` }}
          />
        );
      })}
      {selected >= 0 && (
        <span
          data-effort-handle
          className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-blue-400 bg-white shadow"
          style={{ left: `${percent}%` }}
        />
      )}
    </div>
  );
}

function ModelList({
  models,
  modelId,
  onPick,
}: {
  models: AgentModelOption[];
  modelId?: string;
  onPick: (model: AgentModelOption) => void;
}) {
  const sections = modelSections(models);
  return (
    <div data-model-list role="listbox" aria-label={DESKTOP_ZH.selectModel} className="max-h-80 overflow-y-auto py-2">
      <p className="px-3 pb-1 pt-1 text-sm font-medium text-zinc-100">{DESKTOP_ZH.selectModel}</p>
      {sections.length === 0 ? (
        <p className="px-3 py-2 text-xs text-zinc-500">当前 Agent 没有可选模型</p>
      ) : (
        sections.map((section) => (
          <div key={section.id}>
            <p className="px-3 pb-1 pt-2 text-[11px] text-zinc-500">{section.title}</p>
            {section.models.map((model) => {
              const selected = model.id === modelId;
              return (
                <button
                  key={model.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left [&:hover]:bg-zinc-800"
                  onClick={() => onPick(model)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-100">{model.label}</span>
                  </span>
                  {selected && <Check className="h-4 w-4 shrink-0 text-zinc-100" aria-hidden />}
                </button>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}
