import { useWorkbench } from "@/store";

/** 提问卡片只通过这个钩子回答，不自己读 store。 */
export function useAnswerPrompt() {
  return useWorkbench((s) => s.answerPrompt);
}
