import { useLayoutEffect, type RefObject } from "react";

import { fixedMenuPosition, type MenuSize } from "./fixed-menu-position";

export interface FixedMenuBox {
  top: number;
  left: number;
  maxWidth: number;
  maxHeight: number;
}

export function useFixedMenu(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  onPlace: (box: FixedMenuBox) => void,
  prefer: "below" | "above" = "below",
) {
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const size: MenuSize = { width: menu.offsetWidth, height: menu.offsetHeight };
      const next = fixedMenuPosition({
        anchor: anchor.getBoundingClientRect(),
        menu: size,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        prefer,
      });
      onPlace(next);
    };
    place();
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
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchorRef, menuRef, onClose, onPlace, prefer]);
}
