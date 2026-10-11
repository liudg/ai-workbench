import { create } from "zustand";

import { createPanelSlice } from "./slices/panel";
import { createSettingsSlice } from "./slices/settings";
import { createShellSlice } from "./slices/shell";
import { createSidebarSlice } from "./slices/sidebar";
import { createUpdatesSlice } from "./slices/updates";
import { createWorkspaceSlice } from "./slices/workspace";
import type { WorkbenchState } from "./types";

export type { AppScreen, DialogMode } from "./types";

export const useWorkbench = create<WorkbenchState>()((set, get) => ({
  ...createShellSlice(set, get),
  ...createSidebarSlice(set, get),
  ...createWorkspaceSlice(set, get),
  ...createSettingsSlice(set, get),
  ...createUpdatesSlice(set),
  ...createPanelSlice(set, get),
}));
