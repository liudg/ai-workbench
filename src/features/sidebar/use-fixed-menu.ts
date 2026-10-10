import { useEffect, type RefObject } from "react";

function placeFixedMenu(
  anchor: HTMLElement,
  menu: HTMLElement,
  prefer: "below" | "above",
) {
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = prefer === "below" ? rect.right - width : rect.left;
  left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
  let top = prefer === "above" ? rect.top - height - 6 : rect.bottom + 6;
  if (top + height > window.innerHeight - 8) top = rect.top - height - 6;
  if (top < 8) top = rect.bottom + 6;
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
}

export function useFixedMenu(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  prefer: "below" | "above" = "below",
) {
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (anchor && menu) placeFixedMenu(anchor, menu, prefer);
    };
    place();
    const frame = requestAnimationFrame(place);
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, menuRef, onClose, prefer]);
}
