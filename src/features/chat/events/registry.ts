import type { ComponentType } from "react";

import { AgentMessage } from "./AgentMessage";
import { ErrorNote, ReadOnlyNote, SystemNote } from "./StatusNotes";
import { HandoffNote } from "./HandoffNote";
import { PlanSteps, PlanText } from "./PlanBlocks";
import { PromptEvent } from "./PromptCard";
import { ReviewFindings, ReviewNote } from "./ReviewBlocks";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCall } from "./ToolCall";
import { UserBubble } from "./UserBubble";
import type { RenderedEventKind } from "./event-kinds";
import type { EventViewProps } from "./types";

export const eventRenderers: Record<RenderedEventKind, ComponentType<EventViewProps>> = {
  "user-message": UserBubble,
  "agent-message": AgentMessage,
  thinking: ThinkingBlock,
  "tool-call": ToolCall,
  prompt: PromptEvent,
  system: SystemNote,
  "read-only": ReadOnlyNote,
  error: ErrorNote,
  handoff: HandoffNote,
  "plan-steps": PlanSteps,
  "plan-text": PlanText,
  "review-note": ReviewNote,
  "review-findings": ReviewFindings,
};
