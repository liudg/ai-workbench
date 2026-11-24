// 应用壳启动意图通道：读取冷启动排队的意图，并监听单实例唤醒或 `aiwb://` 深层链接事件。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { isTauri } from "@/lib/daemon/endpoint";

const LAUNCH_INTENT_EVENT = "aiwb://launch-intent";

export type LaunchIntent =
  | {
      kind: "directory";
      path: string;
      prompt?: string;
    }
  | {
      kind: "newPrompt";
      prompt: string;
      project?: string;
    };

export async function drainLaunchIntents(): Promise<LaunchIntent[]> {
  if (!isTauri) return [];
  return invoke<LaunchIntent[]>("drain_launch_intents");
}

export function listenLaunchIntents(onArrival: () => void): () => void {
  if (!isTauri) return () => {};
  let unlisten: (() => void) | null = null;
  let stopped = false;
  void listen(LAUNCH_INTENT_EVENT, () => {
    if (!stopped) onArrival();
  }).then((stop) => {
    if (stopped) stop();
    else unlisten = stop;
  });
  return () => {
    stopped = true;
    unlisten?.();
  };
}
