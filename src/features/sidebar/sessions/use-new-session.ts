import { useWorkbench } from "@/store";

export function useNewSession() {
  const openDraft = useWorkbench((s) => s.openDraft);
  const openSettings = useWorkbench((s) => s.openSettings);
  const installations = useWorkbench((s) => s.installations);
  const profiles = useWorkbench((s) => s.profiles);
  return { openDraft, openSettings, installations, profiles };
}
