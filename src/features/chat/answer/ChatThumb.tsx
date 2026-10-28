import { useEffect, useState } from "react";

import { isTauri } from "@/lib/daemon/endpoint";
import { cn } from "@/lib/utils";
import { resolveLocalChatImage } from "./local-image";

export function ChatThumb({
  path,
  name,
  className,
}: {
  path: string;
  name: string;
  className?: string;
}) {
  const remote = /^(data:|https?:)/i.test(path);
  const [src, setSrc] = useState<string | null>(remote ? path : null);
  const [failed, setFailed] = useState(!remote && !isTauri);

  useEffect(() => {
    if (remote || !isTauri) return;
    let cancelled = false;
    setFailed(false);
    setSrc(null);
    resolveLocalChatImage(path).then(
      (url) => {
        if (!cancelled) setSrc(url);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, remote]);

  if (failed || !src) {
    return (
      <span
        className={cn(
          "flex items-center justify-center overflow-hidden bg-black/25 px-1 text-center text-[10px] leading-3 text-white/80",
          className,
        )}
      >
        {name}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt={name}
      className={cn("bg-black/20", className)}
      onError={() => setFailed(true)}
    />
  );
}
