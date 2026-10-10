import { useEffect, useMemo, useState } from "react";
import { ImageOff } from "lucide-react";

import { isTauri } from "@/lib/ipc";
import { resolveLocalChatImage } from "./local-image";
import { parseMessageContent, type ImageSource } from "./markdown-images";
import { cn } from "@/lib/utils";

export function MessageContent({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const parts = useMemo(() => parseMessageContent(text), [text]);
  const hasImage = parts.some((part) => part.type === "image");
  if (!hasImage) {
    return <p className={cn("whitespace-pre-wrap break-words", className)}>{text}</p>;
  }

  return (
    <div className={cn("min-w-0 max-w-full whitespace-pre-wrap break-words", className)}>
      {parts.map((part, index) =>
        part.type === "text" ? (
          <span key={index}>{part.text}</span>
        ) : (
          <MessageImage
            key={`${index}:${part.source.type}:${part.source.type === "https" ? part.source.url : part.source.path}`}
            alt={part.alt}
            source={part.source}
          />
        ),
      )}
    </div>
  );
}

function reasonText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "无法加载本地图片";
}

export function MessageImage({ alt, source }: { alt: string; source: ImageSource }) {
  const remote = source.type === "https";
  const [src, setSrc] = useState<string | null>(remote ? source.url : null);
  const [failed, setFailed] = useState(source.type === "local" && !isTauri);
  const [reason, setReason] = useState<string | null>(
    source.type === "local" && !isTauri ? "在桌面版中预览" : null,
  );
  const label = alt.trim() || "图片";
  const detail = source.type === "local" ? source.path : source.url;

  useEffect(() => {
    if (source.type !== "local" || !isTauri) return;
    let cancelled = false;
    setFailed(false);
    setReason(null);
    setSrc(null);
    resolveLocalChatImage(source.path).then(
      (url) => {
        if (!cancelled) setSrc(url);
      },
      (error: unknown) => {
        if (cancelled) return;
        setFailed(true);
        setReason(reasonText(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (failed) {
    return <ImageFallback alt={label} detail={detail} reason={reason} />;
  }
  if (!src) {
    return (
      <span
        data-chat-image={source.type}
        data-chat-image-state="loading"
        className="my-2 block h-16 max-w-full animate-pulse rounded-md bg-black/20"
      />
    );
  }

  return (
    <img
      src={src}
      alt={label}
      title={label}
      data-chat-image={source.type}
      data-chat-image-state="ready"
      referrerPolicy="no-referrer"
      className="my-2 block max-h-96 max-w-full rounded-md border border-white/10 bg-zinc-950/40 object-contain"
      onError={() => {
        setFailed(true);
        setReason("图片加载失败");
      }}
    />
  );
}

function ImageFallback({
  alt,
  detail,
  reason,
}: {
  alt: string;
  detail: string;
  reason: string | null;
}) {
  const name = detail.split(/[\\/]/).filter(Boolean).pop() ?? detail;
  return (
    <span
      data-chat-image="fallback"
      data-chat-image-state="fallback"
      className="my-2 flex max-w-full items-center gap-2 rounded-md border border-zinc-700/80 bg-zinc-950/50 px-2.5 py-2 text-left text-xs text-zinc-300"
    >
      <ImageOff className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
      <span className="min-w-0">
        <span className="block">{alt}</span>
        <span className="block truncate font-mono text-[11px] text-zinc-500" title={detail}>
          {name}
        </span>
        {reason ? <span className="block text-[11px] text-zinc-500">{reason}</span> : null}
      </span>
    </span>
  );
}
