import { Image } from "lucide-react";

import { baseName } from "@/shared/path";
import { payloadTitle, type PanelViewer, type ViewerViewProps } from "../core/registry";
import { PreviewFailed, PreviewPending } from "./frame";
import { imageDataUrl, readProjectImage } from "./image-file";
import { matchImage } from "./kinds";

interface ImagePayload {
  title?: string;
  path?: string;
  src?: string;
  error?: string;
}

/** 真实图片。src 来自本机文件字节，不是占位图。 */
export function ImageFrame({ src, name }: { src: string; name: string }) {
  if (!src) return <PreviewFailed message="无法读取图片" />;
  return (
    <div data-image-preview className="flex h-full min-h-0 items-center justify-center overflow-auto bg-[var(--wb-diff-well)] p-6">
      <img
        src={src}
        alt={name}
        className="max-h-full max-w-full rounded-md bg-[repeating-conic-gradient(var(--wb-hover)_0%_25%,transparent_0%_50%)_50%/16px_16px] object-contain ring-1 ring-[var(--wb-border)]"
      />
    </div>
  );
}

function ImageViewerBody({ payload, status }: ViewerViewProps<ImagePayload>) {
  if (status === "loading") return <PreviewPending />;
  if (status === "error") return <PreviewFailed message={payload.error ?? ""} />;
  return <ImageFrame src={payload.src ?? ""} name={payload.title || payload.path || "图片"} />;
}

export const imageViewer: PanelViewer<ImagePayload> = {
  id: "image",
  match: matchImage,
  icon: Image,
  title: (payload) => payloadTitle(payload) || baseName(payload.path || "") || "图片",
  async load(target, ctx) {
    if (target.kind !== "file") return { title: "图片", path: "", src: "" };
    const image = await readProjectImage(ctx.projectId, target.path, ctx.sessionId);
    return {
      title: image.name || baseName(target.path),
      path: image.path,
      src: imageDataUrl(image.mime, image.data_base64),
    };
  },
  View: ImageViewerBody,
};
