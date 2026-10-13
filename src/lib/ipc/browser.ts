import { invoke, subscribe } from "./call";
import type { Backend } from "./contract";
import type { BrowserFile, BrowserNotice } from "./dto";

export const browserCommands: Pick<
  Backend,
  | "prepareBrowserFile"
  | "browserShow"
  | "browserBounds"
  | "browserHide"
  | "browserReload"
  | "browserAnnotate"
  | "browserOpenExternal"
  | "browserClose"
  | "onBrowserNotice"
> = {
  prepareBrowserFile: (projectId, path) =>
    invoke<BrowserFile>("prepare_browser_file", { projectId, path }),
  browserShow: (url, x, y, width, height) =>
    invoke("browser_show", { url, x, y, width, height }),
  browserBounds: (x, y, width, height) =>
    invoke("browser_bounds", { x, y, width, height }),
  browserHide: () => invoke("browser_hide"),
  browserReload: () => invoke("browser_reload"),
  browserAnnotate: (on) => invoke("browser_annotate", { on }),
  browserOpenExternal: (target) => invoke("browser_open_external", { target }),
  browserClose: () => invoke("browser_close"),
  onBrowserNotice: (cb) => subscribe<BrowserNotice>("preview-browser", cb),
};
