import { useWorkbench } from "@/store";

export function useRightPane() {
  return useWorkbench((s) => s.screen);
}
