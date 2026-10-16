import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PromptBodyProps } from "./prompt-props";

function OptionPrompt({ event, session, answerPrompt }: PromptBodyProps) {
  const pick = (value: string) =>
    answerPrompt(session.id, event.prompt_id, { type: "single", value });
  const detailed = event.options.some((opt) => opt.description || opt.disabled_reason);
  if (!detailed) {
    return (
      <div className="flex min-w-0 flex-wrap gap-2 pl-6">
        {event.options.map((opt) => (
          <Button
            key={opt.id}
            size="sm"
            variant={opt.id === "reject" ? "outline" : "default"}
            onClick={() => pick(opt.id)}
          >
            {opt.label}
          </Button>
        ))}
      </div>
    );
  }
  return (
    <div role="listbox" className="flex min-w-0 flex-col gap-1 pl-6">
      {event.options.map((opt, index) => {
        const disabled = Boolean(opt.disabled_reason);
        return (
          <button
            key={opt.id}
            type="button"
            role="option"
            aria-selected={false}
            aria-disabled={disabled}
            disabled={disabled}
            className={cn(
              "flex min-w-0 items-start gap-2 rounded-md border border-zinc-700/70 px-3 py-2 text-left",
              disabled ? "cursor-not-allowed opacity-50" : "hover:border-zinc-500 hover:bg-zinc-800/70",
            )}
            onClick={() => pick(opt.id)}
          >
            <span className="w-4 shrink-0 text-sm text-zinc-500">{index + 1}.</span>
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm text-zinc-100">{opt.label}</span>
              {(opt.disabled_reason || opt.description) && (
                <span className="mt-0.5 block break-words text-xs leading-4 text-zinc-500">
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

export function ChoiceCard(props: PromptBodyProps) {
  return <OptionPrompt {...props} />;
}
