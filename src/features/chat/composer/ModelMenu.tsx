import type { RefObject } from "react";

import { cn } from "@/lib/utils";
import { effortLabel, type AgentModelOption } from "@/types";

export function ModelMenu({
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
              <span className="block truncate text-[11px] text-zinc-500">{model.description}</span>
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
                <span className="truncate text-[11px] text-zinc-500">{effort.description}</span>
              )}
            </button>
          ))}
        </>
      )}
    </div>
  );
}
