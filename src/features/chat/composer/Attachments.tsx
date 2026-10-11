import { X } from "lucide-react";

import type { Attachment } from "@/types";
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
  if (imagesOn) {
    return (
      <div className="mb-2 flex min-w-0 flex-wrap gap-2 overflow-x-hidden px-1">
        {files.map((file) => (
          <div key={file.path} className="group relative h-[72px] w-[72px] shrink-0">
            <ChatThumb path={file.path} name={file.name} className="h-[72px] w-[72px] rounded-xl object-cover" />
            <button
              type="button"
              className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-950/85 text-zinc-100 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
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
    );
  }
  return (
    <div className="mb-2 flex min-w-0 flex-wrap gap-1.5 overflow-x-hidden px-1">
      {files.map((file) => (
        <span
          key={file.path}
          title={file.path}
          className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-1 text-xs text-zinc-200"
        >
          <span className="min-w-0 truncate">{file.name}</span>
          <button
            type="button"
            className="rounded-full text-zinc-400 hover:text-zinc-100"
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
  );
}
