import { usePanelData } from "../core/PanelProvider";

/** 把工作区文件附到当前会话的作曲栏。 */
export function useAttachFile(sessionId: string) {
  const data = usePanelData();
  return (path: string, name: string) => {
    data.attachFile(sessionId, { name, path });
  };
}
