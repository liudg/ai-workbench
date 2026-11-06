import { useState, type MouseEvent } from "react";

import { ContextMenu } from "@/shared/menu/ContextMenu";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";

/** 主标签和文件标签共用菜单；批量关闭交给各自的状态入口。 */
export function useTabContextMenu(ids: readonly string[], onClose: (ids: readonly string[]) => void) {
  const [target, setTarget] = useState<{ id: string; x: number; y: number } | null>(null);
  const others = target ? ids.filter((id) => id !== target.id) : [];
  return {
    open: (event: MouseEvent, id: string) => {
      event.preventDefault();
      event.stopPropagation();
      setTarget({ id, x: event.clientX, y: event.clientY });
    },
    menu: target && ids.includes(target.id) ? (
      <ContextMenu
        x={target.x}
        y={target.y}
        onClose={() => setTarget(null)}
        items={[
          { id: "close-tab", label: DESKTOP_ZH.closeTab, onSelect: () => onClose([target.id]) },
          {
            id: "close-other-tabs",
            label: DESKTOP_ZH.closeOtherTabs,
            disabled: others.length === 0,
            onSelect: () => onClose(others),
          },
          { id: "close-all-tabs", label: DESKTOP_ZH.closeAllTabs, onSelect: () => onClose(ids) },
        ]}
      />
    ) : null,
  };
}
