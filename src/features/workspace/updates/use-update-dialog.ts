import { useWorkbench } from "@/store";

export function useUpdateDialog() {
  const open = useWorkbench((s) => s.updateDialogOpen);
  const update = useWorkbench((s) => s.update);
  const close = useWorkbench((s) => s.closeUpdateDialog);
  const startInstall = useWorkbench((s) => s.startInstall);
  return { open, update, close, startInstall };
}
