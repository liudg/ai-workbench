// 后端传输层。桌面版走 Tauri invoke / listen；网页预览走本机 dev bridge
// （src-tauri/src/bin/dev_bridge.rs），命令和事件都由同一套 Rust 实现处理。
// 网页预览没有本机文件对话框，选择路径时让用户直接输入。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

import { userFacingMessage } from "./user-facing";

export interface PickOptions {
  directory: boolean;
  multiple: boolean;
  title: string;
  filters?: { name: string; extensions: string[] }[];
}

export interface Transport {
  call<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(channel: string, cb: (payload: T) => void): () => void;
  pick(options: PickOptions): Promise<string[]>;
}

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const BRIDGE_PREFIX = "/__bridge";

export const BRIDGE_OFFLINE =
  "网页预览没有连上工作台后端。先运行 cargo run --features dev-bridge --bin dev-bridge。";

const tauriTransport: Transport = {
  call: (cmd, args) => invoke(cmd, args),
  listen<T>(channel: string, cb: (payload: T) => void) {
    let unlisten: (() => void) | undefined;
    let stopped = false;
    void listen<T>(channel, (e) => cb(e.payload)).then((u) => {
      if (stopped) {
        u();
        return;
      }
      unlisten = u;
    });
    return () => {
      stopped = true;
      unlisten?.();
      unlisten = undefined;
    };
  },
  async pick(options) {
    const selected = await open(options);
    if (!selected) return [];
    return Array.isArray(selected) ? selected : [selected];
  },
};

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
let source: EventSource | null = null;

function ensureEventSource() {
  if (source || typeof EventSource === "undefined") return;
  source = new EventSource(`${BRIDGE_PREFIX}/events`);
  source.onmessage = (message) => {
    let parsed: { channel?: string; payload?: unknown };
    try {
      parsed = JSON.parse(message.data);
    } catch {
      return;
    }
    if (!parsed.channel) return;
    for (const cb of listeners.get(parsed.channel) ?? []) cb(parsed.payload);
  };
}

const bridgeTransport: Transport = {
  async call<T>(cmd: string, args?: Record<string, unknown>) {
    let response: Response;
    try {
      response = await fetch(`${BRIDGE_PREFIX}/invoke/${cmd}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args ?? {}),
      });
    } catch {
      throw BRIDGE_OFFLINE;
    }
    if (response.status === 502 || response.status === 504) throw BRIDGE_OFFLINE;
    const body = await response.text();
    let value: unknown = null;
    try {
      value = body ? JSON.parse(body) : null;
    } catch {
      value = null;
    }
    if (!response.ok) {
      const message = userFacingMessage(value);
      if (message) throw message;
      // 空消息会被界面丢掉，避免把 null、JSON 或内部标记画出来。
      throw new Error("");
    }
    return value as T;
  },
  listen<T>(channel: string, cb: (payload: T) => void) {
    ensureEventSource();
    const set = listeners.get(channel) ?? new Set<Listener>();
    const listener = cb as Listener;
    set.add(listener);
    listeners.set(channel, set);
    return () => {
      set.delete(listener);
    };
  },
  async pick(options) {
    const typed = window.prompt(`${options.title}\n网页预览不能打开系统对话框，请输入本机绝对路径：`);
    const path = typed?.trim();
    return path ? [path] : [];
  },
};

export const transport: Transport = isTauri ? tauriTransport : bridgeTransport;
