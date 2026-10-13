import type { Attachment } from "../../../types/index.ts";
import { isImagePath } from "./media.ts";

export type ComposerSubmit =
  | { type: "toggle-plan"; mode: "plan" | "default" }
  | { type: "plan-message"; text: string }
  | { type: "set-goal"; text: string }
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
  goalDraft: boolean;
  supportsGoals: boolean;
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

  const imagePaths = imagePathsOf(input);
  const referenced = referencedFiles(input);
  const slash = value.startsWith("/");
  const body = attachmentBody(value, referenced, input.imagesOn, slash);
  if (input.editingId) {
    if (!body && imagePaths.length === 0) return { type: "noop" };
    return { type: "update-queue", id: input.editingId, text: body, images: imagePaths };
  }
  if (input.pendingId) {
    if (!value || input.composerLocked) return { type: "noop" };
    return { type: "answer", promptId: input.pendingId, text: value };
  }
  if (
    input.goalDraft &&
    input.supportsGoals &&
    value &&
    !value.startsWith("/") &&
    !input.composerLocked
  ) {
    return { type: "set-goal", text: value };
  }
  const canSend = Boolean(body || imagePaths.length);
  if (!canSend || input.composerLocked) return { type: "noop" };
  if (input.imagesOn) return { type: "send-images", text: body, images: imagePaths };
  return { type: "send-text", text: body, clearAttachments: !slash };
}

function imagePathsOf(input: { imagesOn: boolean; attached: readonly Attachment[] }): string[] {
  if (!input.imagesOn) return [];
  return input.attached.filter((file) => isImagePath(file.path)).map((file) => file.path);
}

function referencedFiles(input: { imagesOn: boolean; attached: readonly Attachment[] }): Attachment[] {
  if (!input.imagesOn) return [...input.attached];
  return input.attached.filter((file) => !isImagePath(file.path));
}

/** 图片仍走图像通道。其它文件把真实路径写进消息，避免被当成图片丢掉。 */
function attachmentBody(
  value: string,
  files: readonly Attachment[],
  imagesOn: boolean,
  slash: boolean,
): string {
  if (slash || files.length === 0 || !value) return value;
  const label = files.map((file) => (imagesOn ? file.path : file.name)).join("、");
  return `${value}\n\n附件：${label}`;
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
