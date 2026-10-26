import type { PanelData } from "../core/PanelProvider";

export function imageDataUrl(mime: string, dataBase64: string): string {
  return `data:${mime};base64,${dataBase64}`;
}

/** 按图片命令读取。查看器和预览 hook 都走这里，不在组件里直接调用后端。 */
export async function readProjectImage(data: PanelData, projectId: string, path: string, sessionId?: string) {
  return data.readPreviewImage(projectId, path, sessionId ?? "");
}
