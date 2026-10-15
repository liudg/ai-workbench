import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHAT_MAX_WIDTH,
  CHAT_MIN_WIDTH,
  CLOSED_FILES_RAIL,
  DIFF_LIST_MIN,
  FILES_EXPANDED_WIDTH,
  FILES_RAIL_WIDTH,
  PANEL_PREFERRED_WIDTH,
  PREVIEW_MIN_WIDTH,
  diffListWidth,
  diffListWidthAfterDrag,
  noteFilesRail,
  panelWidthAfterDrag,
  toggleFilesRail,
  toggleFilesSidebar,
  withPreviewRail,
  layoutAfterFullToggle,
  layoutAfterHide,
  layoutAfterOpen,
  layoutAfterShow,
  workspaceColumns,
  type FilesRailState,
} from "./layout.ts";

const SIDEBAR = 260;

function openPreview(state: FilesRailState): FilesRailState {
  return withPreviewRail(state, true);
}

function closePreview(state: FilesRailState): FilesRailState {
  return withPreviewRail(state, false);
}

test("opening the preview collapses the file rail and closing it restores", () => {
  const expanded = openPreview({ ...CLOSED_FILES_RAIL, filesExpanded: true });
  assert.equal(expanded.filesExpanded, false);
  assert.equal(expanded.filesBeforePreview, true);
  assert.equal(closePreview(expanded).filesExpanded, true);
  assert.equal(closePreview(expanded).filesBeforePreview, null);

  const collapsed = openPreview({ ...CLOSED_FILES_RAIL, filesExpanded: false });
  assert.equal(collapsed.filesExpanded, false);
  assert.equal(collapsed.filesBeforePreview, false);
  assert.equal(closePreview(collapsed).filesExpanded, false);
});

test("reopening the rail while a preview is open does not change the restore point", () => {
  let rail = openPreview({ ...CLOSED_FILES_RAIL, filesExpanded: true });
  rail = withPreviewRail(toggleFilesRail(rail), true);
  assert.equal(rail.filesExpanded, true);
  assert.equal(rail.filesTouched, true);
  assert.equal(rail.filesBeforePreview, true);
  rail = withPreviewRail(toggleFilesRail(rail), true);
  assert.equal(rail.filesExpanded, false);
  assert.equal(closePreview(rail).filesExpanded, true);
  assert.equal(closePreview(rail).filesBeforePreview, null);
});

test("a second tab does not recapture the rail, and one remaining tab keeps it collapsed", () => {
  const first = openPreview({ ...CLOSED_FILES_RAIL, filesExpanded: true });
  const second = withPreviewRail(first, true);
  assert.equal(second, first);
  assert.equal(withPreviewRail(first, true).filesExpanded, false);
});

test("files expand when they arrive, unless the user or an open preview already decided", () => {
  const arrived = noteFilesRail(CLOSED_FILES_RAIL, true);
  assert.equal(arrived?.filesExpanded, true);
  assert.equal(noteFilesRail(CLOSED_FILES_RAIL, false), null);
  assert.equal(noteFilesRail({ ...CLOSED_FILES_RAIL, filesTouched: true }, true), null);
  assert.equal(noteFilesRail({ ...CLOSED_FILES_RAIL, filesExpanded: true }, true), null);

  const held = openPreview(CLOSED_FILES_RAIL);
  const remembered = noteFilesRail(held, true);
  assert.equal(remembered?.filesExpanded, false);
  assert.equal(remembered?.filesBeforePreview, true);
  assert.equal(closePreview(remembered ?? held).filesExpanded, true);
});

test("chat stays within 540–760 and extra width goes to the preview", () => {
  const wide = workspaceColumns({
    rowWidth: 1800,
    panelOpen: true,
    filesExpanded: false,
    filesVisible: true,
  });
  assert.equal(wide.chat, CHAT_MAX_WIDTH);
  assert.equal(wide.files, FILES_RAIL_WIDTH);
  assert.equal(wide.panel, 1800 - CHAT_MAX_WIDTH - FILES_RAIL_WIDTH);
  assert.ok(wide.panel > PANEL_PREFERRED_WIDTH);
  assert.equal(wide.chat + wide.panel + wide.files, 1800);

  const fitted = workspaceColumns({
    rowWidth: CHAT_MIN_WIDTH + PANEL_PREFERRED_WIDTH,
    panelOpen: true,
    filesExpanded: false,
    filesVisible: false,
  });
  assert.equal(fitted.chat, CHAT_MIN_WIDTH);
  assert.equal(fitted.panel, PANEL_PREFERRED_WIDTH);

  const medium = workspaceColumns({
    rowWidth: 1280 - SIDEBAR,
    panelOpen: true,
    filesExpanded: false,
    filesVisible: true,
  });
  assert.equal(medium.chat, Math.min(CHAT_MIN_WIDTH, 1280 - SIDEBAR - FILES_RAIL_WIDTH));
  assert.ok(medium.panel < PANEL_PREFERRED_WIDTH);
  assert.equal(medium.files, FILES_RAIL_WIDTH);
  assert.equal(medium.chat + medium.panel + medium.files, 1280 - SIDEBAR);

  const narrow = workspaceColumns({
    rowWidth: 1024 - SIDEBAR,
    panelOpen: true,
    filesExpanded: true,
    filesVisible: true,
  });
  assert.equal(narrow.files, FILES_EXPANDED_WIDTH);
  assert.ok(narrow.panel < medium.panel);
  assert.equal(narrow.chat + narrow.panel + narrow.files, 1024 - SIDEBAR);
});

test("a diff file list hides instead of shrinking below its minimum", () => {
  const widePanel = workspaceColumns({
    rowWidth: 1280 - SIDEBAR,
    panelOpen: true,
    filesExpanded: false,
    filesVisible: false,
  });
  const wideList = diffListWidth(widePanel.panel);
  assert.ok(wideList !== null && wideList >= DIFF_LIST_MIN);

  const narrowPanel = workspaceColumns({
    rowWidth: 1024 - SIDEBAR,
    panelOpen: true,
    filesExpanded: false,
    filesVisible: true,
  });
  assert.equal(diffListWidth(narrowPanel.panel), null);
  assert.equal(diffListWidth(0), null);
  assert.equal(diffListWidth(DIFF_LIST_MIN + 219), null);
});

test("dragging the preview keeps the chat above its minimum and the preview above its floor", () => {
  assert.equal(panelWidthAfterDrag(1600, FILES_RAIL_WIDTH, 900), 900);
  assert.equal(panelWidthAfterDrag(1600, FILES_RAIL_WIDTH, 2000), 1600 - FILES_RAIL_WIDTH - CHAT_MIN_WIDTH);
  assert.equal(panelWidthAfterDrag(1600, 0, 100), PREVIEW_MIN_WIDTH);
  assert.equal(panelWidthAfterDrag(500, 0, 400), 0);
});

test("a wide preview can move both directions from the default split", () => {
  const room = 1600;
  const atDefault = room - CHAT_MAX_WIDTH;
  assert.ok(panelWidthAfterDrag(room, 0, atDefault - 120) < atDefault);
  assert.ok(panelWidthAfterDrag(room, 0, atDefault + 120) > atDefault);
  assert.ok(panelWidthAfterDrag(room, 0, atDefault + 120) <= room - CHAT_MIN_WIDTH);
});

test("dragging the diff file list stays inside the pane", () => {
  assert.equal(diffListWidthAfterDrag(800, 320), 320);
  assert.equal(diffListWidthAfterDrag(800, 20), DIFF_LIST_MIN);
  assert.equal(diffListWidthAfterDrag(800, 900), 800 - 220);
  assert.equal(diffListWidthAfterDrag(300, 200), null);
});

test("the files sidebar toggle does not touch the preview rail", () => {
  const open = { ...CLOSED_FILES_RAIL, filesExpanded: true, filesBeforePreview: true };
  const hidden = toggleFilesSidebar(open);
  assert.equal(hidden.filesSidebarOpen, false);
  assert.equal(hidden.filesExpanded, true);
  assert.equal(hidden.filesBeforePreview, true);
  assert.equal(toggleFilesSidebar(hidden).filesSidebarOpen, true);
});

test("full view gives the preview the whole row and chat nothing", () => {
  const row = workspaceColumns({
    rowWidth: 1400,
    panelOpen: true,
    panelMode: "full",
    filesExpanded: false,
    filesVisible: false,
  });
  assert.equal(row.chat, 0);
  assert.equal(row.panel, 1400);
  assert.equal(row.files, 0);
});

test("layout mode follows open, hide, show, and full view", () => {
  assert.equal(layoutAfterOpen("chat"), "split");
  assert.equal(layoutAfterOpen("full"), "full");
  assert.equal(layoutAfterHide(), "chat");
  assert.equal(layoutAfterShow("chat"), "split");
  assert.equal(layoutAfterShow("full"), "full");
  assert.equal(layoutAfterFullToggle("split"), "full");
  assert.equal(layoutAfterFullToggle("full"), "split");
});

test("closing the preview gives the chat column the file rail's row", () => {
  const row = workspaceColumns({
    rowWidth: 900,
    panelOpen: false,
    filesExpanded: true,
    filesVisible: true,
  });
  assert.equal(row.panel, 0);
  assert.equal(row.files, FILES_EXPANDED_WIDTH);
  assert.equal(row.chat, 900 - FILES_EXPANDED_WIDTH);
});
