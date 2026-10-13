import { useWorkbench } from "@/store";

export function useAccountMenu() {
  const checkUpdates = useWorkbench((s) => s.checkUpdates);
  const openSettings = useWorkbench((s) => s.openSettings);
  const checking = useWorkbench((s) => s.update.kind === "checking");
  return { checkUpdates, openSettings, checking };
}
