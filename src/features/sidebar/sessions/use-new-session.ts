import { useWorkbench } from "@/store";

export function useNewSession() {
  const openDraft = useWorkbench((s) => s.openDraft);
  const openSettings = useWorkbench((s) => s.openSettings);
  const installations = useWorkbench((s) => s.installations);
  return { openDraft, openSettings, installations };
}
