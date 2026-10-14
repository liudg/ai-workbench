import { useEffect, type RefObject } from "react";

function placeMenu(anchor: HTMLElement, menu: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = rect.left + rect.width / 2 - width / 2;
  if (left + width > window.innerWidth - 8) {
    left = window.innerWidth - width - 8;
  }
  left = Math.max(8, left);
  let top = rect.top - height - 8;
  if (top < 8) top = rect.bottom + 8;
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

export function useComposerMenu(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (anchor && menu) placeMenu(anchor, menu);
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
      if (event.key === "Escape") onClose();
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
  }, [open, anchorRef, menuRef, onClose]);
}
