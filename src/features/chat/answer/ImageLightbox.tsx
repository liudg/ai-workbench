import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import { ChatThumb } from "./ChatThumb";

export interface LightboxImage {
  path: string;
  name: string;
}

/** 消息里的图片放大看。同一条消息的多张图用左右键切换，Esc 或点背景关闭（t3code `ExpandedImageDialog.tsx`）。 */
export function ImageLightbox({
  images,
  start,
  onClose,
}: {
  images: readonly LightboxImage[];
  start: number;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(start);
  const count = images.length;
  const step = (direction: -1 | 1) => setIndex((current) => (current + direction + count) % count);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (count <= 1 || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      event.preventDefault();
      event.stopPropagation();
      setIndex((current) => (current + (event.key === "ArrowLeft" ? -1 : 1) + count) % count);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [count, onClose]);

  const image = images[index];
  if (!image || typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={image.name}
      data-image-lightbox
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80"
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <ChatThumb
        key={image.path}
        path={image.path}
        name={image.name}
        className="max-h-[86vh] max-w-[86vw] rounded-lg object-contain shadow-2xl"
      />
      <button
        type="button"
        aria-label={DESKTOP_ZH.imagePreviewClose}
        className="absolute right-4 top-4 rounded-full bg-black/60 p-2 text-white transition-colors hover:bg-black/80"
        onClick={onClose}
      >
        <X className="h-4 w-4" />
      </button>
      {count > 1 ? (
        <>
          <button
            type="button"
            aria-label={DESKTOP_ZH.imagePreviewPrevious}
            className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white transition-colors hover:bg-black/80"
            onClick={() => step(-1)}
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            aria-label={DESKTOP_ZH.imagePreviewNext}
            className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white transition-colors hover:bg-black/80"
            onClick={() => step(1)}
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </>
      ) : null}
    </div>,
    document.body,
  );
}
