import { useWorkbench } from "@/store";

export function useProjectHeader() {
  return useWorkbench((s) => s.openDialog);
}
