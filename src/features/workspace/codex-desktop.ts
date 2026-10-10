/**
 * 官方 Codex 桌面端文案（OpenAI.Codex 26.1007.2314.0）。
 * 交互入口用这些字符串，不另起一套说法。
 */
export const CODEX_DESKTOP = {
  reviewTitle: "Code review",
  reviewDescription: "Review uncommitted changes or compare against a branch",
  reviewUncommitted: "Review uncommitted changes",
  reviewBase: "Review against a base branch",
  reviewCommit: "Review a commit",
  reviewSearchBranches: "Search branches",
  reviewUseBranch: "Use {branch}",
  reviewLoadingBranches: "Loading branches...",
  reviewBranchesError: "Unable to load branches",
  reviewRetry: "Retry",
  reviewNoBranches: "No branches found",
  planTitle: "Plan mode",
  planOn: "Turn plan mode on",
  planOff: "Turn plan mode off",
  planLabel: "Plan",
  planTooltip: "Create a plan",
  implementPrompt: "Implement this plan?",
  implementOption: "Yes, implement this plan",
  implementId: "implement",
  viewChanges: "View changes",
  fileChanged: "1 file changed",
  filesChanged: "{count} files changed",
  editMessage: "Edit message",
  editLatestOnly: "Only the most recent message can be edited.",
  editWhileRunning: "Cannot edit a message while a turn is in progress.",
  editConfirm:
    "Rewinding removes this turn and later turns from the conversation. Local file changes are not reverted.",
} as const;
