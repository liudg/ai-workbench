import { useWorkbench } from "@/store";

export function usePinnedSessionIds(): string[] {
  return useWorkbench((state) => state.pinnedSessionIds);
}
