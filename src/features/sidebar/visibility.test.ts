import assert from "node:assert/strict";
import { test } from "node:test";

import { isSidebarOpen, setSidebarOpen, toggleSidebar } from "./visibility.ts";

test("the sidebar starts open and toggles closed", () => {
  setSidebarOpen(true);
  assert.equal(isSidebarOpen(), true);
  toggleSidebar();
  assert.equal(isSidebarOpen(), false);
  toggleSidebar();
  assert.equal(isSidebarOpen(), true);
});
