import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";

import {
  closeTerminal,
  resizeTerminal,
  watchTerminal,
  writeTerminal,
} from "./api";
import { runKeys, takeTerminalRuns, watchTerminalRuns } from "./terminal-runs";

export interface TerminalPayload {
  title?: string;
  terminalId?: string;
}

export interface TerminalState {
  hostRef: React.RefObject<HTMLDivElement>;
  exited: boolean;
  exitCode: number | null;
  error: string | null;
  restart: () => void;
}

/** 同一个标签只开一个 shell。StrictMode 下挂载两次也只开一次。 */
const opening = new Map<string, Promise<string>>();

/**
 * 把面板标签接到 daemon 里的终端：没有终端就开一个并记进标签载荷，
 * 有就订阅它的输出。聊天里排着的命令在终端接上后送进去。
 */
export function useTerminal({
  tabId,
  sessionId,
  terminalId,
  open,
  patchPayload,
}: {
  tabId: string;
  sessionId: string;
  terminalId: string | undefined;
  /** 在面板的工作目录里开 shell。 */
  open: (cols: number, rows: number) => Promise<string>;
  patchPayload: (patch: Partial<TerminalPayload>) => void;
}): TerminalState {
  const hostRef = useRef<HTMLDivElement>(null);
  const [term, setTerm] = useState<Terminal | null>(null);
  const [exited, setExited] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const patchRef = useRef(patchPayload);
  patchRef.current = patchPayload;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let dispose: (() => void) | null = null;
    let live = true;
    void loadXterm().then((xterm) => {
      if (live) dispose = mountTerminal(host, xterm, setTerm);
    });
    return () => {
      live = false;
      dispose?.();
    };
  }, []);

  useEffect(() => {
    if (terminalId || !term) return;
    const key = `${sessionId}/${tabId}`;
    let pending = opening.get(key);
    if (!pending) {
      pending = openRef.current(term.cols, term.rows);
      opening.set(key, pending);
      void pending.finally(() => opening.delete(key)).catch(() => {});
    }
    let live = true;
    setError(null);
    pending.then(
      // 标签已经关掉时改载荷不生效。
      (id) => patchRef.current({ terminalId: id }),
      (reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [sessionId, tabId, terminalId, term]);

  useEffect(() => {
    if (!terminalId || !term) return;
    let attached = false;
    let ended = false;
    // 重放回滚内容时，里面旧的查询（比如光标位置 ESC[6n）会让 xterm 再回答一次。
    // 这些回答不能当成输入送进 shell，否则 shell 会吞掉后面的按键。
    let replaying = 0;
    const flushRuns = () => {
      if (!attached || ended) return;
      for (const command of takeTerminalRuns(sessionId)) {
        void writeTerminal(terminalId, runKeys(command)).catch(() => {});
      }
    };
    const stopWatch = watchTerminal(terminalId, (push) => {
      if (push.reset) {
        term.reset();
        replaying += 1;
        term.write(push.data ?? "", () => {
          replaying -= 1;
        });
      } else if (push.data) {
        term.write(push.data);
      }
      ended = Boolean(push.exited) || (ended && !push.reset);
      if (push.reset || push.exited) {
        setExited(ended);
        setExitCode(push.exitCode ?? null);
      }
      if (push.reset) {
        attached = true;
        void resizeTerminal(terminalId, term.cols, term.rows).catch(() => {});
        flushRuns();
      }
    });
    const stopRuns = watchTerminalRuns(sessionId, flushRuns);
    const input = term.onData((data) => {
      if (!ended && replaying === 0) void writeTerminal(terminalId, data).catch(() => {});
    });
    const resize = term.onResize(({ cols, rows }) => {
      if (!ended) void resizeTerminal(terminalId, cols, rows).catch(() => {});
    });
    return () => {
      stopWatch();
      stopRuns();
      input.dispose();
      resize.dispose();
    };
  }, [sessionId, terminalId, term]);

  const restart = useCallback(() => {
    setExited(false);
    setExitCode(null);
    setError(null);
    term?.reset();
    if (terminalId) void closeTerminal(terminalId).catch(() => {});
    patchRef.current({ terminalId: undefined });
  }, [term, terminalId]);

  return { hostRef, exited, exitCode, error, restart };
}

type Xterm = Awaited<ReturnType<typeof loadXterm>>;

/** xterm 一加载就要浏览器环境，用到时再载入。 */
async function loadXterm() {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    import("@xterm/xterm/css/xterm.css"),
  ]);
  return { Terminal, FitAddon };
}

/** 颜色和字体跟着宿主元素的样式走，尺寸跟着宿主元素变。 */
function mountTerminal(host: HTMLElement, { Terminal, FitAddon }: Xterm, onTerm: (term: Terminal | null) => void) {
  const style = getComputedStyle(host);
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: style.getPropertyValue("--font-mono").trim() || "Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.2,
    scrollback: 5000,
    theme: {
      background: style.backgroundColor,
      foreground: style.color,
      cursor: style.color,
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();
  const observer = new ResizeObserver(() => {
    if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
  });
  observer.observe(host);
  term.focus();
  onTerm(term);
  return () => {
    observer.disconnect();
    onTerm(null);
    term.dispose();
  };
}
