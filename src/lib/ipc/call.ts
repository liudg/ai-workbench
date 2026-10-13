import type { Attachment } from "@/types";
import { transport } from "../transport";

export const invoke = <T = void>(cmd: string, args?: Record<string, unknown>) =>
  transport.call<T>(cmd, args);

export function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  return transport.listen<T>(channel, cb);
}

export function attachments(paths: string[]): Attachment[] {
  return paths.map((path) => ({
    name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
    path,
  }));
}
