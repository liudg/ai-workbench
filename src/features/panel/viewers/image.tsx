import { Image } from "lucide-react";

import { backend } from "@/lib/ipc";
import { baseName } from "../files/path";
import { payloadTitle, type PanelViewer, type ViewerViewProps } from "../core/registry";
import { PreviewFailed, PreviewPending } from "./frame";
import { matchImage } from "./kinds";

interface ImagePayload {
  title?: string;
  path?: string;
  src?: string;
  error?: string;
}

export function imageDataUrl(mime: string, dataBase64: string): string {
  return `data:${mime};base64,${dataBase64}`;
}

/** 真实图片。src 来自本机文件字节，不是占位图。 */
export function ImageFrame({ src, name }: { src: string; name: string }) {
  if (!src) return <PreviewFailed message="无法读取图片" />;
  return (
    <div data-image-preview className="flex h-full min-h-0 items-center justify-center overflow-auto bg-zinc-950 p-6">
      <img src={src} alt={name} className="max-h-full max-w-full object-contain" />
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
    const image = await backend.readPreviewImage(ctx.projectId, target.path);
    return {
      title: image.name || baseName(target.path),
      path: image.path,
      src: imageDataUrl(image.mime, image.data_base64),
    };
  },
  View: ImageViewerBody,
};
