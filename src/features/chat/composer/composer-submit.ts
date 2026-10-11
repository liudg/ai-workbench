import type { Attachment } from "../../../types.ts";

export type ComposerSubmit =
  | { type: "toggle-plan"; mode: "plan" | "default" }
  | { type: "plan-message"; text: string }
  | { type: "open-review" }
  | { type: "noop" }
  | { type: "update-queue"; id: string; text: string; images: string[] }
  | { type: "answer"; promptId: string; text: string }
  | { type: "send-images"; text: string; images: string[] }
  | { type: "send-text"; text: string; clearAttachments: boolean };

export function decideSubmit(input: {
  text: string;
  supportsPlan: boolean;
  supportsReview: boolean;
  planOn: boolean;
  imagesOn: boolean;
  attached: readonly Attachment[];
  editingId: string | null;
  pendingId: string | null;
  composerLocked: boolean;
}): ComposerSubmit {
  const value = input.text.trim();
  if (input.supportsPlan && value === "/plan") {
    return { type: "toggle-plan", mode: input.planOn ? "default" : "plan" };
  }
  const planRequest = value.match(/^\/plan\s+([\s\S]+)$/);
  if (input.supportsPlan && planRequest?.[1]) {
    return { type: "plan-message", text: planRequest[1].trim() };
  }
  if (input.supportsReview && value === "/review") return { type: "open-review" };

  const imagePaths = input.imagesOn ? input.attached.map((file) => file.path) : [];
  if (input.editingId) {
    if (!value && imagePaths.length === 0) return { type: "noop" };
    return { type: "update-queue", id: input.editingId, text: value, images: imagePaths };
  }
  if (input.pendingId) {
    if (!value || input.composerLocked) return { type: "noop" };
    return { type: "answer", promptId: input.pendingId, text: value };
  }
  const canSend = Boolean(value || imagePaths.length);
  if (!canSend || input.composerLocked) return { type: "noop" };
  if (input.imagesOn) return { type: "send-images", text: value, images: imagePaths };
  const slash = value.startsWith("/");
  const body =
    !slash && input.attached.length > 0
      ? `${value}\n\n附件：${input.attached.map((file) => file.name).join("、")}`
      : value;
  return { type: "send-text", text: body, clearAttachments: !slash };
}

export function decideSlash(
  command: { name: string; takes_args?: boolean },
  caps: { supports_review?: boolean; supports_plan?: boolean } | undefined,
  planOn: boolean,
): { type: "review" } | { type: "toggle-plan"; mode: "plan" | "default" } | { type: "fill"; text: string } {
  if (command.name === "/review" && caps?.supports_review) return { type: "review" };
  if (command.name === "/plan" && caps?.supports_plan) {
    return { type: "toggle-plan", mode: planOn ? "default" : "plan" };
  }
  return { type: "fill", text: command.takes_args ? `${command.name} ` : command.name };
}

export function effortForModel(
  model: { default_effort: string; efforts: readonly { id: string }[] },
  selectedEffort: string | undefined,
): string {
  return model.efforts.some((item) => item.id === selectedEffort)
    ? selectedEffort || model.default_effort
    : model.default_effort || model.efforts[0]?.id || "";
}
