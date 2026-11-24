// 长按 `Ctrl`（Windows/Linux）或 `Cmd`（macOS）超过 180ms 时，显示侧边栏前 9 个会话的跳转数字角标。
// 一旦按下任意其他键、松开修饰键或窗口失焦，立即取消。

import { useEffect, useState } from "react";

import { detectShortcutPlatform } from "../../shared/keybindings/shortcut.ts";
import type { ShortcutPlatform } from "../../shared/keybindings/types.ts";

export const MOD_HOLD_DELAY_MS = 180;

export interface ModHoldKeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  getModifierState?: (key: string) => boolean;
}

export function isPureModKeyDown(
  event: ModHoldKeyInput,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): boolean {
  if (event.getModifierState?.("AltGraph")) return false;
  if (platform === "mac") {
    return event.key === "Meta" && !event.ctrlKey && !event.altKey && !event.shiftKey;
  }
  return event.key === "Control" && !event.metaKey && !event.altKey && !event.shiftKey;
}

export function isModStillPressed(
  event: Pick<ModHoldKeyInput, "key" | "ctrlKey" | "metaKey">,
  platform: ShortcutPlatform = detectShortcutPlatform(),
): boolean {
  if (platform === "mac") {
    return event.key !== "Meta" && event.metaKey;
  }
  return event.key !== "Control" && event.ctrlKey;
}

function hasBlockingOverlay(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector(
      "[data-keybinding-recording='true'], [data-command-menu], [data-file-search], [role='dialog'], [role='alertdialog']",
    ),
  );
}

export function useModHold(delayMs = MOD_HOLD_DELAY_MS): boolean {
  const [holding, setHolding] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const platform = detectShortcutPlatform();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let armed = false;

    const cancel = () => {
      armed = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      setHolding(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isPureModKeyDown(event, platform)) {
        if (event.repeat || armed) return;
        if (hasBlockingOverlay()) {
          cancel();
          return;
        }
        armed = true;
        timer = setTimeout(() => {
          timer = null;
          if (
            !armed ||
            hasBlockingOverlay() ||
            (typeof document !== "undefined" &&
              typeof document.hasFocus === "function" &&
              !document.hasFocus())
          ) {
            cancel();
            return;
          }
          setHolding(true);
        }, delayMs);
        return;
      }
      cancel();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!isModStillPressed(event, platform)) {
        cancel();
      }
    };

    const onVisibility = () => {
      if (typeof document !== "undefined" && document.hidden) cancel();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("mousedown", cancel, true);
    window.addEventListener("contextmenu", cancel, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancel();
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("mousedown", cancel, true);
      window.removeEventListener("contextmenu", cancel, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [delayMs]);

  return holding;
}
