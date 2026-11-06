/** 正在跑，或在等用户输入 / 批准。这些排在项目组前面。 */
export function isPinnedSession(status: string | null | undefined): boolean {
  return status === "starting" || status === "running" || status === "needs-input";
}
