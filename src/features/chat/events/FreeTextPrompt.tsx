import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PromptBodyProps } from "./prompt-props";

export function FreeTextPrompt({ event, session, answerPrompt }: PromptBodyProps) {
  const [freeText, setFreeText] = useState("");
  return (
    <form
      className="flex min-w-0 gap-2 pl-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (freeText.trim()) {
          answerPrompt(session.id, event.prompt_id, {
            type: "single",
            value: freeText.trim(),
          });
        }
      }}
    >
      <Input
        value={freeText}
        onChange={(e) => setFreeText(e.target.value)}
        placeholder="输入你的回答…"
        className="h-8 min-w-0 flex-1"
        autoFocus
      />
      <Button type="submit" size="sm" className="h-8 shrink-0">
        回答
      </Button>
    </form>
  );
}
