import { useCallback, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { useFixedMenu, type FixedMenuBox } from "./use-fixed-menu";

/** 挂到 document.body，避免侧栏里的 transform / overflow 把 fixed 菜单裁切并撑出横向滚动。 */
export function FixedMenu({
  open,
  anchorRef,
  onClose,
  prefer = "below",
  className,
  label,
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  prefer?: "below" | "above";
  className?: string;
  label: string;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<FixedMenuBox | null>(null);
  const onPlace = useCallback((next: FixedMenuBox) => {
    setBox((current) =>
      current &&
      current.top === next.top &&
      current.left === next.left &&
      current.maxWidth === next.maxWidth &&
      current.maxHeight === next.maxHeight
        ? current
        : next,
    );
  }, []);
  useFixedMenu(open, anchorRef, menuRef, onClose, onPlace, prefer);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      className={cn("fixed z-50 overflow-x-hidden overflow-y-auto", className)}
      style={
        box
          ? {
              top: box.top,
              left: box.left,
              maxWidth: box.maxWidth,
              maxHeight: box.maxHeight,
              visibility: "visible",
            }
          : { top: 0, left: 0, visibility: "hidden" }
      }
    >
      {children}
    </div>,
    document.body,
  );
}
