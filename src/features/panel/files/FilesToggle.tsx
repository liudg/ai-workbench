import { PanelRightOpen } from "lucide-react";

import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";

/** 文件列收起后留在工作区右上角，只把文件列叫回来。 */
export function FilesToggle({ onShow }: { onShow: () => void }) {
  return (
    <button
      type="button"
      data-files-toggle
      aria-pressed={false}
      title={DESKTOP_ZH.filesShowSidebar}
      aria-label={DESKTOP_ZH.filesShowSidebar}
      className="absolute right-2 top-1.5 z-30 inline-flex h-6 w-6 items-center justify-center rounded text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50"
      onClick={onShow}
    >
      <PanelRightOpen className="h-3.5 w-3.5" />
    </button>
  );
}
