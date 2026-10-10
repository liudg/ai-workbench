import { FolderOpen, MessagesSquare } from "lucide-react";

import { useWorkbench } from "@/store";
import { NewSessionButton } from "./NewSessionButton";
import { Button } from "./ui/button";

export function NoProjectSelected() {
  const openDialog = useWorkbench((s) => s.openDialog);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-800/80">
        <FolderOpen className="h-6 w-6 text-zinc-400" />
      </div>
      <div>
        <h2 className="text-lg font-medium text-zinc-200">选择一个项目</h2>
        <p className="mt-1 max-w-72 text-sm leading-6 text-zinc-500">
          每个项目可以并行运行多个 Agent 会话，会话在后台持续执行，随时回来查看。
        </p>
      </div>
      <div className="flex gap-2">
        <Button onClick={() => openDialog("create")}>创建项目</Button>
        <Button variant="outline" onClick={() => openDialog("import")}>
          导入文件夹
        </Button>
      </div>
    </div>
  );
}

export function NoSession({ projectId }: { projectId: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-800/80">
        <MessagesSquare className="h-6 w-6 text-zinc-400" />
      </div>
      <div>
        <h2 className="text-lg font-medium text-zinc-200">还没有会话</h2>
        <p className="mt-1 max-w-72 text-sm leading-6 text-zinc-500">
          会话是 Agent 的一次工作上下文。同一项目可开多个会话并行处理不同任务。
        </p>
      </div>
      <NewSessionButton projectId={projectId} appearance="primary" title="新建会话" />
    </div>
  );
}
