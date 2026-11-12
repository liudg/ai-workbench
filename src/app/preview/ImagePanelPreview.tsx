import { useEffect, useState } from "react";

import { PanelTabs, usePanel } from "@/features/panel";
import { ProjectPanel } from "@/features/workspace";
import { projectIdForRoot } from "./preview-project";

/** 开发预览：文件树点 png，经查看器注册表在标签里显示真实图片。 */
export default function ImagePanelPreview() {
  const root = new URLSearchParams(window.location.search).get("root") ?? "";
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!root) {
      setError("没有项目目录");
      return;
    }
    let cancel = false;
    void (async () => {
      try {
        const id = await projectIdForRoot(root, "image-fixture");
        if (!cancel) setProjectId(id);
      } catch (err: unknown) {
        if (!cancel) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancel = true;
    };
  }, [root]);

  if (!projectId) {
    return (
      <p className="p-6 text-sm text-wb-fg-2" data-image-panel-status>
        {error || "正在读取…"}
      </p>
    );
  }

  return (
    <ProjectPanel projectId={projectId} path={root} title="preview">
      <ImagePanelBoot />
    </ProjectPanel>
  );
}

function ImagePanelBoot() {
  const { openFiles } = usePanel();
  useEffect(() => {
    openFiles();
  }, [openFiles]);
  return (
    <div className="h-screen bg-wb-surface text-wb-fg">
      <PanelTabs />
    </div>
  );
}
