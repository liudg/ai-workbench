// 终端和 daemon 之间的调用。展示组件不直接碰连接。

import { daemon } from "@/lib/daemon";
import { terminalTopic } from "@/lib/daemon/topics";

/** 订阅时先收到 `reset` 的完整回滚内容，之后只收新增输出，shell 退出时收到 `exited`。 */
export interface TerminalPush {
  reset?: boolean;
  data?: string;
  exited?: boolean;
  exitCode?: number | null;
}

/** 新会话发出第一条消息后，终端归到建好的会话，删会话时一起关掉。 */
export function adoptTerminal(id: string, sessionId: string) {
  return daemon.call<null>("terminals.adopt", { id, sessionId });
}

export function writeTerminal(id: string, data: string) {
  return daemon.call<null>("terminals.write", { id, data });
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  return daemon.call<null>("terminals.resize", { id, cols, rows });
}

export function closeTerminal(id: string) {
  return daemon.call<null>("terminals.close", { id });
}

export function watchTerminal(id: string, listener: (push: TerminalPush) => void) {
  return daemon.subscribe(terminalTopic(id), (data) => listener((data ?? {}) as TerminalPush));
}
