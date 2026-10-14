import { emptySandbox, type AccessMode, type SessionSandbox } from "../types/index.ts";

const ACCESS_MODES: readonly AccessMode[] = ["full", "ask", "read-only", "approve-for-me"];

/** 协议里的档位 id。不认识的 id 不当成一档。 */
export function accessModeFromId(id: string | null | undefined): AccessMode | null {
  if (!id) return null;
  return ACCESS_MODES.includes(id as AccessMode) ? (id as AccessMode) : null;
}

/** 新建会话只用这个 Agent 自己记住的沙箱，或它的 profile 默认档。 */
export function initialSandbox(
  remembered: SessionSandbox | undefined,
  defaultAccess: string | null | undefined,
): SessionSandbox | null {
  if (remembered) return remembered;
  const mode = accessModeFromId(defaultAccess);
  return mode ? emptySandbox(mode) : null;
}
