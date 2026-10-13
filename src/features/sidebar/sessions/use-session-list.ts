import { isReadOnlyOpen } from "@/lib/utils";
import { useWorkbench } from "@/store";
import type { Session } from "@/types";

export function useReadOnlySessionKey(sessions: Session[]) {
  return useWorkbench((s) => {
    let key = "";
    for (const session of sessions) {
      if (isReadOnlyOpen(s.events[session.id])) key += `${session.id}\n`;
    }
    return key;
  });
}
