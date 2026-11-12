import { useState } from "react";
import { X } from "lucide-react";

import type { Attachment } from "@/types";
import { isImagePath } from "./media";
import { ChatThumb } from "../answer/ChatThumb";
import { ImageLightbox } from "../answer/ImageLightbox";

export function Attachments({
  files,
  imagesOn,
  onRemove,
  onOpenFile,
}: {
  files: Attachment[];
  imagesOn: boolean;
  onRemove: (path: string) => void;
  /** 不传则文件名只展示，不能点开。 */
  onOpenFile?: (path: string) => void;
}) {
  const [opened, setOpened] = useState<number | null>(null);
  if (files.length === 0) return null;
  const pictures = imagesOn ? files.filter((file) => isImagePath(file.path)) : [];
  const chips = imagesOn ? files.filter((file) => !isImagePath(file.path)) : files;
  return (
    <>
      {pictures.length > 0 ? (
        <div className="mb-2 flex min-w-0 flex-wrap gap-2 px-1 pr-1.5 pt-1.5">
          {pictures.map((file, index) => (
            <div key={file.path} data-attachment={file.path} className="group relative h-[72px] w-[72px] shrink-0">
              <button
                type="button"
                data-chat-image-open
                aria-label={`预览 ${file.name}`}
                className="block h-[72px] w-[72px] cursor-zoom-in p-0"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpened(index);
                }}
              >
                <ChatThumb path={file.path} name={file.name} className="h-[72px] w-[72px] rounded-xl object-cover" />
              </button>
              <button
                type="button"
                className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-wb-border-strong bg-wb-popover text-wb-fg-2 opacity-0 shadow-xs transition-opacity hover:text-wb-fg group-hover:opacity-100 focus-visible:opacity-100"
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
      {opened != null && pictures.length > 0 ? (
        <ImageLightbox
          images={pictures}
          start={Math.min(opened, pictures.length - 1)}
          onClose={() => setOpened(null)}
        />
      ) : null}
      {chips.length > 0 ? (
        <div className="mb-2 flex min-w-0 flex-wrap gap-1.5 overflow-x-hidden px-1">
          {chips.map((file) => (
            <span
              key={file.path}
              title={file.path}
              data-attachment={file.path}
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-lg border border-wb-border bg-wb-surface px-2.5 py-1 text-xs text-wb-fg"
            >
              {onOpenFile ? (
                <button
                  type="button"
                  data-attachment-open
                  className="min-w-0 truncate text-left hover:text-wb-accent hover:underline"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenFile(file.path);
                  }}
                >
                  {file.name}
                </button>
              ) : (
                <span className="min-w-0 truncate">{file.name}</span>
              )}
              <button
                type="button"
                className="rounded-full text-wb-fg-2 hover:text-wb-fg"
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
