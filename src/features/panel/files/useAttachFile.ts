import { useWorkbench } from "@/store";

/** 把工作区文件附到当前会话。打开文件页不直接写 store。 */
export function useAttachFile(sessionId: string) {
  return (path: string, name: string) => {
    useWorkbench.getState().addAttachments(sessionId, [{ name, path }]);
  };
}
