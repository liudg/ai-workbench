import { useMemo } from "react";
import { ImageOff } from "lucide-react";

import { parseMessageContent, type ImageSource } from "@/shared/markdown/markdown-images";
import { cn } from "@/lib/utils";
import { useChatImage } from "./useChatImage";

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

export function MessageImage({ alt, source }: { alt: string; source: ImageSource }) {
  const { state, fail } = useChatImage(source);
  const label = alt.trim() || "图片";
  const detail = source.type === "local" ? source.path : source.url;

  if (state.status === "fallback") {
    return <ImageFallback alt={label} detail={detail} reason={state.reason} />;
  }
  if (state.status === "loading") {
    return (
      <span
        data-chat-image={source.type}
        data-chat-image-state="loading"
        className="my-2 block h-16 max-w-full animate-pulse rounded-md bg-[var(--wb-chip)]"
      />
    );
  }

  return (
    <img
      src={state.src}
      alt={label}
      title={label}
      data-chat-image={source.type}
      data-chat-image-state="ready"
      referrerPolicy="no-referrer"
      className="my-2 block max-h-96 max-w-full rounded-md border border-[var(--wb-border)] bg-[var(--wb-well)] object-contain"
      onError={() => fail("图片加载失败")}
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
      className="my-2 flex max-w-full items-center gap-2 rounded-lg border border-[var(--wb-border)] bg-[var(--wb-well)] px-2.5 py-2 text-left text-xs text-[var(--wb-text)]"
    >
      <ImageOff className="h-3.5 w-3.5 shrink-0 text-[var(--wb-muted)]" />
      <span className="min-w-0">
        <span className="block">{alt}</span>
        <span className="block truncate font-mono text-[11px] text-[var(--wb-muted)]" title={detail}>
          {name}
        </span>
        {reason ? <span className="block text-[11px] text-[var(--wb-muted)]">{reason}</span> : null}
      </span>
    </span>
  );
}
