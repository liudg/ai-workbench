import { useEffect, useState } from "react";

import { useWorkspaceContextLabel } from "@/features/workspace";
import {
  closeNativeWindow,
  hasNativeWindowControls,
  minimizeNativeWindow,
  startNativeWindowDrag,
  subscribeNativeWindowMaximized,
  toggleMaximizeNativeWindow,
} from "@/lib/native/window-controls";

export interface WindowTitlebarState {
  nativeControls: boolean;
  maximized: boolean;
  contextLabel: string | null;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  startDrag: () => void;
}

export function useWindowTitlebar(): WindowTitlebarState {
  const contextLabel = useWorkspaceContextLabel();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!hasNativeWindowControls) return;
    return subscribeNativeWindowMaximized(setMaximized);
  }, []);

  return {
    nativeControls: hasNativeWindowControls,
    maximized,
    contextLabel,
    minimize: minimizeNativeWindow,
    toggleMaximize: toggleMaximizeNativeWindow,
    close: closeNativeWindow,
    startDrag: startNativeWindowDrag,
  };
}
