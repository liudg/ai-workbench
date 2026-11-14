import { useLayoutEffect, type RefObject } from "react";

import { isImeKey } from "../keyboard";

export type ComposerMenuAlign = "center" | "end";

export function placeComposerMenu(
  anchor: HTMLElement,
  menu: HTMLElement,
  align: ComposerMenuAlign = "center",
) {
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (align === "end") {
    const maxRight = Math.max(8, vw - width - 8);
    const right = Math.min(Math.max(8, vw - rect.right), maxRight);
    menu.style.left = "auto";
    menu.style.right = `${right}px`;
  } else {
    let left = rect.left + rect.width / 2 - width / 2;
    if (left + width > vw - 8) {
      left = vw - width - 8;
    }
    left = Math.max(8, left);
    menu.style.right = "auto";
    menu.style.left = `${left}px`;
  }

  if (rect.top - height - 8 < 8 && vh - rect.bottom > rect.top) {
    menu.style.bottom = "auto";
    menu.style.top = `${rect.bottom + 8}px`;
  } else {
    menu.style.top = "auto";
    menu.style.bottom = `${Math.max(8, vh - rect.top + 8)}px`;
  }
}

export function useComposerMenu(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  token?: unknown,
  align: ComposerMenuAlign = "center",
) {
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (anchor && menu) placeComposerMenu(anchor, menu, align);
    };
    place();
    let observer: ResizeObserver | null = null;
    const watch = () => {
      const menu = menuRef.current;
      if (!menu || observer) return;
      observer = new ResizeObserver(place);
      observer.observe(menu);
    };
    watch();
    const frame = requestAnimationFrame(() => {
      place();
      watch();
    });
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        isImeKey({ composing: event.isComposing, keyCode: event.keyCode }) ||
        event.defaultPrevented
      ) {
        return;
      }
      event.preventDefault();
      onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
    };
  }, [open, anchorRef, menuRef, onClose, token, align]);
}
