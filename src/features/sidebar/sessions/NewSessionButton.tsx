import type { MouseEvent as ReactMouseEvent } from "react";
import { SquarePen } from "lucide-react";

import type { ProjectScope } from "@/shared/shell/navigation";
import { SidebarPlusButton } from "../projects/SidebarPlusButton";
import { useNewSession } from "./use-new-session";

/** 开一个新会话。Agent 和模型在新会话的作曲栏里选。 */
export function NewSessionButton({
  projectId,
  appearance = "pencil",
  className,
  title = "新建会话",
}: {
  projectId: ProjectScope;
  appearance?: "pencil" | "plus";
  className?: string;
  title?: string;
}) {
  const openNew = useNewSession();
  const onPress = (event: ReactMouseEvent) => {
    event.stopPropagation();
    openNew(projectId);
  };

  if (appearance === "plus") {
    return <SidebarPlusButton label={title} title={title} className={className} onClick={onPress} />;
  }
  return (
    <button type="button" className={className} aria-label={title} title={title} onClick={onPress}>
      <SquarePen className="h-3.5 w-3.5" />
    </button>
  );
}
