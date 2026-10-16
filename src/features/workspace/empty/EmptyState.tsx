import type { ReactNode } from "react";
import { FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useEmptyProject } from "./use-empty-project";

function EmptyPane({
  icon,
  title,
  body,
  children,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-800/80">
        {icon}
      </div>
      <div>
        <h2 className="text-lg font-medium text-zinc-200">{title}</h2>
        <p className="mt-1 max-w-72 text-sm leading-6 text-zinc-500">{body}</p>
      </div>
      {children}
    </div>
  );
}

export function NoProjectSelected() {
  const openDialog = useEmptyProject();
  return (
    <EmptyPane
      icon={<FolderOpen className="h-6 w-6 text-zinc-400" />}
      title="选择一个项目"
      body="每个项目可以并行运行多个 Agent 会话，会话在后台持续执行，随时回来查看。"
    >
      <div className="flex gap-2">
        <Button onClick={() => openDialog("create")}>创建项目</Button>
        <Button variant="outline" onClick={() => openDialog("import")}>
          导入文件夹
        </Button>
      </div>
    </EmptyPane>
  );
}
