import { useWorkbench } from "@/store";

export function useEmptyProject() {
  return useWorkbench((s) => s.openDialog);
}
