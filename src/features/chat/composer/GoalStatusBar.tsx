/** 目标模式时贴在作曲栏卡片上方。文案来自当前会话的目标快照。 */
export function GoalStatusBar({ text }: { text: string }) {
  return (
    <p
      data-goal-status
      title={text}
      className="mb-2 min-w-0 truncate px-2 text-xs leading-5 text-fuchsia-300"
    >
      {text}
    </p>
  );
}
