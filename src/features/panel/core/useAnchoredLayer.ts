import { useLayoutEffect, type RefObject } from "react";

import { layerOffset } from "./layer-offset";

export function useAnchoredLayer(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  layerRef: RefObject<HTMLElement | null>,
  revision: string,
  align: "start" | "end" = "end",
) {
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const layer = layerRef.current;
      if (!anchor || !layer) return;
      const rect = anchor.getBoundingClientRect();
      const next = layerOffset({
        anchorLeft: rect.left,
        anchorRight: rect.right,
        anchorTop: rect.top,
        anchorBottom: rect.bottom,
        width: layer.offsetWidth,
        height: layer.offsetHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        align,
      });
      layer.style.top = `${next.top}px`;
      layer.style.left = `${next.left}px`;
    };
    place();
    const frame = requestAnimationFrame(place);
    const observer = layerRef.current ? new ResizeObserver(place) : null;
    if (layerRef.current && observer) observer.observe(layerRef.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [align, anchorRef, layerRef, open, revision]);
}
