import { useEffect, useState } from "react";

import { isTauri } from "@/lib/ipc";
import type { ImageSource } from "@/shared/markdown/markdown-images";
import { resolveLocalChatImage } from "./local-image";

export type ChatImageState =
  | { status: "loading" }
  | { status: "ready"; src: string }
  | { status: "fallback"; reason: string | null };

/** 远程图片直接用地址。本机图片经桌面端校验后再换成 asset URL。 */
export function useChatImage(source: ImageSource): {
  state: ChatImageState;
  fail: (reason: string) => void;
} {
  const remote = source.type === "https";
  const [state, setState] = useState<ChatImageState>(
    remote
      ? { status: "ready", src: source.url }
      : isTauri
        ? { status: "loading" }
        : { status: "fallback", reason: "在桌面版中预览" },
  );

  useEffect(() => {
    if (source.type === "https") {
      setState({ status: "ready", src: source.url });
      return;
    }
    if (!isTauri) {
      setState({ status: "fallback", reason: "在桌面版中预览" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    resolveLocalChatImage(source.path).then(
      (url) => {
        if (!cancelled) setState({ status: "ready", src: url });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "fallback", reason: reasonText(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source]);

  return {
    state,
    fail: (reason: string) => setState({ status: "fallback", reason }),
  };
}

function reasonText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return "无法加载本地图片";
}
