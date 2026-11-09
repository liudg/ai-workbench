const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Codex 侧边栏相对时间：刚刚 / N分钟 / N小时 / N天 / M月D日。 */
export function relativeSessionTime(updatedAt: number, now: number): string {
  const delta = Math.max(0, now - updatedAt);
  if (delta < MINUTE) return "刚刚";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}分钟`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}小时`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}天`;
  const date = new Date(updatedAt);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 句子里用的相对时间：刚刚 / N分钟前 / N小时前 / N天前 / M月D日。 */
export function relativeTimeAgo(at: number, now: number): string {
  const delta = Math.max(0, now - at);
  const label = relativeSessionTime(at, now);
  return delta >= MINUTE && delta < 7 * DAY ? `${label}前` : label;
}
