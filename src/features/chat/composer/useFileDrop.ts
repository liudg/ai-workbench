import { useEffect, useRef, useState, type RefObject } from "react";

import { listenFileDrop } from "@/lib/native/file-drop";

/** 系统文件拖到 `zone` 上时高亮，松手时交出路径。拖到别处不接。 */
export function useFileDrop(
  zone: RefObject<HTMLElement | null>,
  enabled: boolean,
  onDrop: (paths: string[]) => void,
): boolean {
  const [over, setOver] = useState(false);
  const latest = useRef({ enabled, onDrop });
  latest.current = { enabled, onDrop };

  useEffect(
    () =>
      listenFileDrop((drop) => {
        if (drop.type === "leave") {
          setOver(false);
          return;
        }
        const rect = zone.current?.getBoundingClientRect();
        const inside =
          latest.current.enabled &&
          rect != null &&
          drop.x >= rect.left &&
          drop.x <= rect.right &&
          drop.y >= rect.top &&
          drop.y <= rect.bottom;
        if (drop.type === "over") {
          setOver(inside);
          return;
        }
        setOver(false);
        if (inside && drop.paths.length) latest.current.onDrop(drop.paths);
      }),
    [zone],
  );

  return over && enabled;
}
