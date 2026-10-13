import { useLayoutEffect, type RefObject } from "react";

export function useAnchoredLayer(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  layerRef: RefObject<HTMLElement | null>,
  revision: string,
) {
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const layer = layerRef.current;
      if (!anchor || !layer) return;
      const rect = anchor.getBoundingClientRect();
      const width = layer.offsetWidth;
      const height = layer.offsetHeight;
      let left = rect.right - width;
      left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
      let top = rect.bottom + 6;
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
      layer.style.top = `${top}px`;
      layer.style.left = `${left}px`;
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
  }, [anchorRef, layerRef, open, revision]);
}
