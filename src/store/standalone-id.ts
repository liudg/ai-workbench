/** 还没发出的独立聊天。首发成功后换成真实项目 id。 */
export const STANDALONE_DRAFT_ID = "standalone";

export const STANDALONE_DRAFT_TITLE = "新聊天";

export function isStandaloneDraft(projectId: string | null | undefined): boolean {
  return projectId === STANDALONE_DRAFT_ID;
}
