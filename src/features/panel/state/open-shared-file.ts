import { DESKTOP_ZH } from "../../../shared/strings/desktop-zh.ts";
import { canonicalOpenPath, openFileInPlace, openFilesPlace } from "../files/open-files-place.ts";
import { placeTab, readTitle, type SessionPanel } from "./panel-session.ts";

export const OPEN_FILES_TAB_ID = "custom:open-files";

/** 把一次文件打开并进「打开文件」标签。不另建 markdown / 文本薄壳。 */
export function sessionAfterSharedFileOpen(
  session: SessionPanel,
  projectPath: string,
  requestedPath: string,
  line: number | null,
): SessionPanel {
  const path = canonicalOpenPath(projectPath, requestedPath);
  if (!path) return session;
  const existing = session.tabs.find((tab) => tab.id === OPEN_FILES_TAB_ID);
  const place = openFileInPlace(openFilesPlace(existing?.payload), path, line);
  const base =
    existing?.payload && typeof existing.payload === "object"
      ? { ...(existing.payload as Record<string, unknown>) }
      : {};
  const title = readTitle(existing?.payload) || DESKTOP_ZH.openFiles;
  return placeTab(
    session,
    {
      id: OPEN_FILES_TAB_ID,
      viewerId: "files",
      status: "ready",
      payload: {
        ...base,
        title,
        type: "open-files",
        path: place.path,
        line: place.line,
        filter: place.filter,
        tabs: place.tabs,
      },
    },
    false,
    true,
  );
}
