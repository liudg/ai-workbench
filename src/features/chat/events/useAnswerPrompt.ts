import { useChatHost } from "../host";

/** 提问卡片只通过这个钩子回答。 */
export function useAnswerPrompt() {
  return useChatHost().answerPrompt;
}
