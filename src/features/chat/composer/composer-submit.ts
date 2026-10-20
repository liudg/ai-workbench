import { mergeSnippetText } from "../../../shared/text-snippet.ts";
import type { Attachment } from "../../../types/index.ts";
import { isImagePath } from "./media.ts";

type SnippetClear = { clearSnippets?: true };

export type ComposerSubmit =
  | { type: "toggle-plan"; mode: "plan" | "default" }
  | ({ type: "plan-message"; text: string } & SnippetClear)
  | { type: "set-goal"; text: string }
  | { type: "open-review" }
  | { type: "noop" }
  | ({ type: "update-queue"; id: string; text: string; images: string[] } & SnippetClear)
  | ({ type: "answer"; promptId: string; text: string } & SnippetClear)
  | ({ type: "send-images"; text: string; images: string[] } & SnippetClear)
  | ({ type: "send-text"; text: string; clearAttachments: boolean } & SnippetClear);

export function decideSubmit(input: {
  text: string;
  supportsPlan: boolean;
  supportsReview: boolean;
  planOn: boolean;
  imagesOn: boolean;
  attached: readonly Attachment[];
  snippets?: readonly { quote: string }[];
  editingId: string | null;
  pendingId: string | null;
  /** 缺省仍把作曲栏当成该提问的回答。审批的决定只来自审批卡。 */
  pendingKind?: string | null;
  composerLocked: boolean;
  goalDraft: boolean;
  supportsGoals: boolean;
}): ComposerSubmit {
  const value = input.text.trim();
  const snippets = input.snippets ?? [];
  if (input.supportsPlan && value === "/plan") {
    return { type: "toggle-plan", mode: input.planOn ? "default" : "plan" };
  }
  const planRequest = value.match(/^\/plan\s+([\s\S]+)$/);
  if (input.supportsPlan && planRequest?.[1]) {
    return { type: "plan-message", ...withSnippets(planRequest[1].trim(), snippets) };
  }
  if (input.supportsReview && value === "/review") return { type: "open-review" };

  const imagePaths = imagePathsOf(input);
  const referenced = referencedFiles(input);
  const slash = value.startsWith("/");
  const message = messageBody(value, snippets, referenced, input.imagesOn, slash);
  if (input.editingId) {
    if (!message.text && imagePaths.length === 0) return { type: "noop" };
    return { type: "update-queue", id: input.editingId, text: message.text, images: imagePaths, ...message.clear };
  }
  if (input.pendingId && input.pendingKind !== "approval") {
    if (!value || input.composerLocked) return { type: "noop" };
    const answer = withSnippets(value, snippets);
    return { type: "answer", promptId: input.pendingId, ...answer };
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
  const canSend = Boolean(message.text || imagePaths.length);
  if (!canSend || input.composerLocked) return { type: "noop" };
  if (input.imagesOn) return { type: "send-images", text: message.text, images: imagePaths, ...message.clear };
  return { type: "send-text", text: message.text, clearAttachments: !slash, ...message.clear };
}

function withSnippets(
  value: string,
  snippets: readonly { quote: string }[],
): { text: string; clearSnippets?: true } {
  const text = mergeSnippetText(value, snippets);
  return snippets.some((item) => item.quote.trim()) ? { text, clearSnippets: true } : { text };
}

/** 斜杠命令不吞文本片。其余消息先接围栏，再接文件名。 */
function messageBody(
  value: string,
  snippets: readonly { quote: string }[],
  files: readonly Attachment[],
  imagesOn: boolean,
  slash: boolean,
): { text: string; clear: { clearSnippets?: true } } {
  if (slash) return { text: value, clear: {} };
  const merged = withSnippets(value, snippets);
  return {
    text: attachmentBody(merged.text, files, imagesOn, false),
    clear: merged.clearSnippets ? { clearSnippets: true } : {},
  };
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
