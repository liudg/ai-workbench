import { useEffect, useState } from "react";

import { backend } from "@/lib/ipc";
import { imageDataUrl } from "../viewers/image";

export type PreviewImageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; src: string; name: string };

/** 按图片读取，不走文本预览。 */
export function usePreviewImage(projectId: string, path: string): PreviewImageState {
  const [state, setState] = useState<PreviewImageState>({ status: "loading" });

  useEffect(() => {
    if (!path) return;
    let cancel = false;
    setState({ status: "loading" });
    void backend.readPreviewImage(projectId, path).then(
      (image) => {
        if (cancel) return;
        setState({
          status: "ready",
          src: imageDataUrl(image.mime, image.data_base64),
          name: image.name || path,
        });
      },
      (err: unknown) => {
        if (cancel) return;
        setState({ status: "error", message: errorText(err) });
      },
    );
    return () => {
      cancel = true;
    };
  }, [path, projectId]);

  return state;
}

function errorText(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err instanceof Error && err.message.trim()) return err.message;
  return "无法读取图片";
}
