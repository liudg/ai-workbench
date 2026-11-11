import { useMemo } from "react";

import { cn } from "@/lib/utils";
import type { ImageSource } from "@/shared/markdown/markdown-images";
import { useChatImage } from "./useChatImage";

export function ChatThumb({
  path,
  name,
  className,
}: {
  path: string;
  name: string;
  className?: string;
}) {
  const source = useMemo<ImageSource>(
    () => (/^(data:|https?:)/i.test(path) ? { type: "https", url: path } : { type: "local", path }),
    [path],
  );
  const { state, fail } = useChatImage(source);

  if (state.status !== "ready") {
    return (
      <span
        className={cn(
          "flex items-center justify-center overflow-hidden bg-[var(--wb-chip)] px-1 text-center text-[10px] leading-3 text-[var(--wb-muted)]",
          className,
        )}
      >
        {name}
      </span>
    );
  }

  return (
    <img
      src={state.src}
      alt={name}
      className={cn("bg-[var(--wb-well)]", className)}
      onError={() => fail("图片加载失败")}
    />
  );
}
