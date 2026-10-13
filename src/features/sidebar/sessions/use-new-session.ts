import { useWorkbench } from "@/store";

export function useNewSession() {
  const createSession = useWorkbench((s) => s.createSession);
  const openSettings = useWorkbench((s) => s.openSettings);
  const installations = useWorkbench((s) => s.installations);
  return { createSession, openSettings, installations };
}
