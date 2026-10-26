import { useUpdateCheck } from "@/features/updates";
import { openSettings } from "@/shared/shell/navigation";

export function useAccountMenu() {
  const { checking, checkNow } = useUpdateCheck();
  return { checkUpdates: checkNow, openSettings, checking };
}
