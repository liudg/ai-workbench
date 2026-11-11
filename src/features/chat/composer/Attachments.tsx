import { X } from "lucide-react";

import type { Attachment } from "@/types";
import { isImagePath } from "./media";
import { ChatThumb } from "../answer/ChatThumb";

export function Attachments({
  files,
  imagesOn,
  onRemove,
}: {
  files: Attachment[];
  imagesOn: boolean;
  onRemove: (path: string) => void;
}) {
  if (files.length === 0) return null;
  const pictures = imagesOn ? files.filter((file) => isImagePath(file.path)) : [];
  const chips = imagesOn ? files.filter((file) => !isImagePath(file.path)) : files;
  return (
    <>
      {pictures.length > 0 ? (
        <div className="mb-2 flex min-w-0 flex-wrap gap-2 overflow-x-hidden px-1">
          {pictures.map((file) => (
            <div key={file.path} data-attachment={file.path} className="group relative h-[72px] w-[72px] shrink-0">
              <ChatThumb
                path={file.path}
                name={file.name}
                className="h-[72px] w-[72px] rounded-xl border border-[var(--wb-border)] object-cover"
              />
              <button
                type="button"
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--wb-border-strong)] bg-[var(--wb-elev)] text-[var(--wb-text-strong)] opacity-0 shadow-sm transition-all hover:bg-[var(--wb-hover-strong)] group-hover:opacity-100 focus-visible:opacity-100"
                aria-label={`移除 ${file.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(file.path);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {chips.length > 0 ? (
        <div className="mb-2 flex min-w-0 flex-wrap gap-1.5 overflow-x-hidden px-1">
          {chips.map((file) => (
            <span
              key={file.path}
              title={file.path}
              data-attachment={file.path}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-lg border border-[var(--wb-border-strong)] bg-[var(--wb-chip)] py-1 pl-2.5 pr-1 text-xs text-[var(--wb-text-strong)]"
            >
              <span className="min-w-0 truncate">{file.name}</span>
              <button
                type="button"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[var(--wb-muted)] transition-colors hover:bg-[var(--wb-hover-strong)] hover:text-[var(--wb-text-strong)]"
                aria-label={`移除 ${file.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(file.path);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}
