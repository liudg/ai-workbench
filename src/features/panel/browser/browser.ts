/**
 * 预览面板内置浏览器的地址、标题和历史运算。
 * 每个标签的历史记在面板 store 里，按会话分开，切换会话不用清空。
 */

export interface BrowserEntry {
  /** 地址栏显示的文字。本地文件用磁盘路径。 */
  address: string;
  /** 交给 webview 的地址。 */
  target: string;
  /** 页面加载完成前不出现批注。 */
  loaded?: boolean;
}

export interface BrowserHistory {
  entries: BrowserEntry[];
  index: number;
}

export function emptyHistory(): BrowserHistory {
  return { entries: [], index: -1 };
}

export function currentEntry(history: BrowserHistory): BrowserEntry | null {
  return history.entries[history.index] ?? null;
}

/** 标签重新挂载时沿用这一条。主窗口上已有子 webview 后，再向后端要文件地址会失败。 */
export function entryToRestore(history: BrowserHistory): BrowserEntry | null {
  const current = currentEntry(history);
  return current?.target ? current : null;
}

export function canGoBack(history: BrowserHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: BrowserHistory): boolean {
  return history.index >= 0 && history.index + 1 < history.entries.length;
}

export function visit(history: BrowserHistory, entry: BrowserEntry): BrowserHistory {
  const current = currentEntry(history);
  if (current && current.target === entry.target && current.address === entry.address) {
    return history;
  }
  const entries = history.entries.slice(0, history.index + 1);
  entries.push(entry);
  return { entries, index: entries.length - 1 };
}

export function goBack(history: BrowserHistory): BrowserHistory {
  if (!canGoBack(history)) return history;
  return { ...history, index: history.index - 1 };
}

export function goForward(history: BrowserHistory): BrowserHistory {
  if (!canGoForward(history)) return history;
  return { ...history, index: history.index + 1 };
}

/** 页面加载完成后，把重定向写进当前记录，其它地址另开一条。 */
export function noteLoaded(history: BrowserHistory, loadedUrl: string): BrowserHistory {
  const file = fileAddressFromAssetUrl(loadedUrl);
  const address = file ?? loadedUrl;
  const target = loadedUrl;
  if (!address || address === "about:blank") return history;
  const current = currentEntry(history);
  if (!current) return visit(history, { address, target, loaded: true });
  if (current.target === target || (file && current.address === file)) {
    if (current.loaded && current.address === address && current.target === target) return history;
    const entries = history.entries.slice();
    entries[history.index] = {
      address: file ?? current.address,
      target,
      loaded: true,
    };
    return { ...history, entries };
  }
  return visit(history, { address, target, loaded: true });
}

export function displayFileAddress(path: string): string {
  return path.replace(/^\\\\\?\\/, "").replace(/\\/g, "/");
}

export function fileAddressFromAssetUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "asset.localhost") return null;
  let path = decodeURIComponent(parsed.pathname);
  if (path.startsWith("/")) path = path.slice(1);
  if (!path) return null;
  return path.replace(/\\/g, "/");
}

export type AddressPlan =
  | { kind: "navigate"; address: string; target: string }
  | { kind: "file"; path: string }
  | { kind: "invalid" };

export function parseAddressInput(raw: string): AddressPlan {
  const text = raw.trim();
  if (!text || /[\u0000-\u001f]/.test(text)) return { kind: "invalid" };
  if (/^(javascript|data|file):/i.test(text)) return { kind: "invalid" };
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (url.protocol !== "http:" && url.protocol !== "https:") return { kind: "invalid" };
      return { kind: "navigate", address: url.toString(), target: url.toString() };
    } catch {
      return { kind: "invalid" };
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\") || text.startsWith("/")) {
    return { kind: "file", path: text };
  }
  if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(text) && !/\s/.test(text)) {
    const url = `https://${text}`;
    return { kind: "navigate", address: url, target: url };
  }
  const query = encodeURIComponent(text);
  const url = `https://www.bing.com/search?q=${query}`;
  return { kind: "navigate", address: url, target: url };
}
