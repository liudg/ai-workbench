import { useEffect, useState } from "react";

import { isTauri } from "@/lib/daemon/endpoint";
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

  // 流式答复每次重新解析都会给出新的 source 对象，按地址判断，避免本机图片反复回到加载中。
  const address = source.type === "https" ? source.url : source.path;
  useEffect(() => {
    if (remote) {
      setState({ status: "ready", src: address });
      return;
    }
    if (!isTauri) {
      setState({ status: "fallback", reason: "在桌面版中预览" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    resolveLocalChatImage(address).then(
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
  }, [address, remote]);

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
