import type { ReactNode } from "react";

import { Tooltip } from "@/components/ui/tooltip";

/** 面板与顶栏工具按钮提示，委托共享 Portal 级 Tooltip 渲染，避免滚动条裁切与双重原生提示。 */
export function Hint({
  label,
  shortcut,
  side = "bottom",
  align = "center",
  children,
}: {
  label: string;
  shortcut?: string;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  children: ReactNode;
}) {
  return (
    <Tooltip label={label} shortcut={shortcut} side={side} align={align}>
      {children}
    </Tooltip>
  );
}
