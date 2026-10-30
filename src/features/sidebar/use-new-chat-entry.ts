import { useNavigation } from "@/shared/shell/navigation";
import { useNewSession } from "./sessions/use-new-session";

export function useNewChatEntry() {
  const openNew = useNewSession();
  const active = useNavigation(
    (state) => !state.settings && !state.board && state.view.kind === "new" && state.view.projectId === null,
  );
  return { active, open: () => openNew(null) };
}
