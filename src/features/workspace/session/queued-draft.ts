import type { QueuedTurn } from "../../../types/catalog.ts";
import type { ComposerDraft } from "./composer-drafts.ts";

export function withQueuedDraft(current: ComposerDraft, item: QueuedTurn): ComposerDraft {
  const files = [...new Set(item.images ?? [])].filter((path) => !current.files.some((file) => file.path === path))
    .map((path) => ({ path, name: path.split(/[\\/]/).slice(-1)[0] ?? path }));
  return { ...current, text: [current.text, item.text].filter(Boolean).join("\n"), files: [...current.files, ...files] };
}
