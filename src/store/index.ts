import { create } from "zustand";

import { createPanelSlice } from "@/features/panel/state/slice";
import { writeDraftSnapshot } from "./draft-storage";
import { createDraftSlice } from "./slices/drafts";
import { createSettingsSlice } from "./slices/settings";
import { createShellSlice } from "./slices/shell";
import { createSidebarSlice } from "./slices/sidebar";
import { createUpdatesSlice } from "./slices/updates";
import { createWorkspaceSlice } from "./slices/workspace";
import type { WorkbenchState } from "./types";
import {
  browserUnreadStorage,
  syncUnreadFinished,
  writeUnreadFinishedIds,
} from "@/shared/unread-finished";

export type { AppScreen, DialogMode } from "./types";

export const useWorkbench = create<WorkbenchState>()((set, get) => ({
  ...createShellSlice(set, get),
  ...createSidebarSlice(set, get),
  ...createWorkspaceSlice(set, get),
  ...createSettingsSlice(set, get),
  ...createUpdatesSlice(set),
  ...createPanelSlice(set, get),
  ...createDraftSlice(set, get),
}));

useWorkbench.subscribe((state, previous) => {
  if (
    state.drafts === previous.drafts &&
    state.draftFocused === previous.draftFocused &&
    state.attachments === previous.attachments &&
    state.textSnippets === previous.textSnippets &&
    state.sandboxes === previous.sandboxes &&
    state.tuning === previous.tuning
  ) {
    return;
  }
  writeDraftSnapshot(state);
});

// 侧栏状态来自会话列表刷新。结束且当时没打开，就记一笔未读。
useWorkbench.subscribe((state, previous) => {
  if (
    state.sessions === previous.sessions &&
    state.unreadFinishedIds === previous.unreadFinishedIds &&
    state.selectedProjectId === previous.selectedProjectId &&
    state.activeSessionId === previous.activeSessionId
  ) {
    return;
  }
  const ids = syncUnreadFinished(previous, state);
  if (!ids) return;
  useWorkbench.setState({ unreadFinishedIds: ids });
  writeUnreadFinishedIds(browserUnreadStorage(), ids);
});
