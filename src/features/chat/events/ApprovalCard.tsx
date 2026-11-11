import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PromptBodyProps } from "./prompt-props";

export interface ChoiceCardProps extends PromptBodyProps {
  flush?: boolean;
  activeIndex?: number;
  onActiveIndexChange?: (index: number) => void;
}

function OptionPrompt({
  event,
  session,
  answerPrompt,
  flush = false,
  activeIndex,
  onActiveIndexChange,
}: ChoiceCardProps) {
  const pick = (value: string) =>
    answerPrompt(session.id, event.prompt_id, { type: "single", value });
  const pad = flush ? "" : "pl-6";
  const detailed = event.options.some((opt) => opt.description || opt.disabled_reason);
  if (!detailed) {
    return (
      <div className={cn("flex min-w-0 flex-wrap gap-2", pad)}>
        {event.options.map((opt, index) => (
          <Button
            key={opt.id}
            size="sm"
            variant={opt.id === "reject" ? "outline" : "default"}
            data-option-id={opt.id}
            onFocus={() => onActiveIndexChange?.(index)}
            onClick={() => pick(opt.id)}
          >
            {opt.label}
          </Button>
        ))}
      </div>
    );
  }
  return (
    <div role="listbox" className={cn("flex min-w-0 flex-col gap-1.5", pad)}>
      {event.options.map((opt, index) => {
        const disabled = Boolean(opt.disabled_reason);
        const active = !disabled && activeIndex === index;
        return (
          <button
            key={opt.id}
            type="button"
            role="option"
            data-option-id={opt.id}
            aria-selected={active}
            aria-disabled={disabled}
            disabled={disabled}
            className={cn(
              "flex min-w-0 items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wb-accent)]/35",
              disabled
                ? "cursor-not-allowed border-[var(--wb-border)] opacity-50"
                : active
                  ? "border-[var(--wb-border-strong)] bg-[var(--wb-hover-strong)]"
                  : "border-[var(--wb-border)] hover:border-[var(--wb-border-strong)] hover:bg-[var(--wb-hover)]",
            )}
            onMouseEnter={() => {
              if (!disabled) onActiveIndexChange?.(index);
            }}
            onFocus={() => onActiveIndexChange?.(index)}
            onClick={() => pick(opt.id)}
          >
            <span
              className={cn(
                "mt-0.5 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-[11px] tabular-nums",
                active
                  ? "bg-[var(--wb-chip-hover)] text-[var(--wb-text-strong)]"
                  : "bg-[var(--wb-chip)] text-[var(--wb-muted)]",
              )}
            >
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm font-medium text-[var(--wb-text-strong)]">
                {opt.label}
              </span>
              {(opt.disabled_reason || opt.description) && (
                <span className="mt-0.5 block break-words text-xs leading-4 text-[var(--wb-muted)]">
                  {opt.disabled_reason ?? opt.description}
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ChoiceCard({ flush = false, ...props }: ChoiceCardProps) {
  return <OptionPrompt flush={flush} {...props} />;
}
