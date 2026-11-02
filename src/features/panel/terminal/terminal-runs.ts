/** 从聊天里点「运行」的命令。终端还没开好时先排着，开好后按顺序送进 shell。 */

type Listener = () => void;

const queued = new Map<string, string[]>();
const listeners = new Map<string, Set<Listener>>();

export function queueTerminalRun(sessionId: string, command: string) {
  const text = command.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!text.trim()) return;
  queued.set(sessionId, [...(queued.get(sessionId) ?? []), text]);
  for (const listener of listeners.get(sessionId) ?? []) listener();
}

/** 取走这个会话排着的命令。 */
export function takeTerminalRuns(sessionId: string): string[] {
  const runs = queued.get(sessionId) ?? [];
  queued.delete(sessionId);
  return runs;
}

export function watchTerminalRuns(sessionId: string, listener: Listener) {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(sessionId);
  };
}

/** 送进 shell 的按键：每行回车执行。 */
export function runKeys(command: string): string {
  return `${command.split("\n").join("\r")}\r`;
}
