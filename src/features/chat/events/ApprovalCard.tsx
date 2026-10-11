import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { PromptBodyProps } from "./prompt-props";

function OptionPrompt({ event, session, answerPrompt }: PromptBodyProps) {
  const [freeText, setFreeText] = useState("");
  return (
    <div className="flex min-w-0 flex-wrap gap-2 pl-6">
      {event.options.map((opt) => (
        <Button
          key={opt.id}
          size="sm"
          variant={opt.id === "reject" ? "outline" : "default"}
          onClick={() =>
            answerPrompt(session.id, event.prompt_id, {
              type: "single",
              value: opt.id,
            })
          }
        >
          {opt.label}
        </Button>
      ))}
      {event.question === DESKTOP_ZH.implementPrompt && (
        <form
          className="flex min-w-0 basis-full gap-2"
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault();
            if (!freeText.trim()) return;
            answerPrompt(session.id, event.prompt_id, {
              type: "single",
              value: freeText.trim(),
            });
          }}
        >
          <Input
            value={freeText}
            onChange={(change) => setFreeText(change.target.value)}
            aria-label={DESKTOP_ZH.other}
            placeholder={DESKTOP_ZH.other}
            className="h-8 min-w-0 flex-1"
          />
          <Button type="submit" size="sm" variant="outline" className="h-8 shrink-0">
            {DESKTOP_ZH.other}
          </Button>
        </form>
      )}
    </div>
  );
}

export function ApprovalCard(props: PromptBodyProps) {
  return <OptionPrompt {...props} />;
}

export function ChoiceCard(props: PromptBodyProps) {
  return <OptionPrompt {...props} />;
}
