import { useEffect, useState } from "react";

import { PanelTabs } from "../core/PanelTabs";
import { projectIdForRoot } from "./preview-project";
import { PanelProvider, usePanel } from "../core/PanelProvider";

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
      <p className="p-6 text-sm text-zinc-400" data-image-panel-status>
        {error || "正在读取…"}
      </p>
    );
  }

  return (
    <PanelProvider
      sessionId="preview"
      projectId={projectId}
      projectPath={root}
      sessionTitle="preview"
      agent={null}
      events={[]}
    >
      <ImagePanelBoot />
    </PanelProvider>
  );
}

function ImagePanelBoot() {
  const { openFiles } = usePanel();
  useEffect(() => {
    openFiles();
  }, [openFiles]);
  return (
    <div className="h-screen bg-zinc-950">
      <PanelTabs />
    </div>
  );
}
