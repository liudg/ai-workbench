import { useNeedsYouCount } from "@/features/board";
import { closeBoard, openBoard, useNavigation } from "@/shared/shell/navigation";

export function useBoardEntry() {
  const open = useNavigation((state) => state.board);
  return {
    open,
    count: useNeedsYouCount(),
    toggle: () => (open ? closeBoard() : openBoard()),
  };
}
