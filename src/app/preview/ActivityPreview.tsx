import type { Session, SessionEvent, SessionEventBody, SessionStatus } from "@/types";
import { PreviewSession } from "./PreviewSession";
import { ACTIVITY_PREVIEW_PROFILES } from "./use-activity-preview";

function session(id: string, title: string, status: SessionStatus): Session {
  return {
    id,
    project_id: "preview",
    agent: "codex-cli",
    native_id: id,
    title,
    status,
    created_at: 1,
    updated_at: 1,
  };
}

/** 预览里的时间从打开页面前一分多钟算起，进行中末行的计时才像真的。 */
const START = Date.now() - 75_000;

function event(sessionId: string, id: string, seq: number, ts: number, body: SessionEventBody): SessionEvent {
  return { id, session_id: sessionId, seq, ts: START + ts, ...body };
}

const TEST_OUTPUT = Array.from({ length: 260 }, (_, index) =>
  index % 40 === 39 ? `FAIL src/case-${index}.test.ts` : `ok ${index + 1} - case ${index + 1}`,
).join("\n");

const commandEvents: SessionEvent[] = [
  event("activity-command", "user", 1, 1_000, { kind: "user-message", text: "跑一下测试，修掉失败的。" }),
  event("activity-command", "lint", 2, 2_000, {
    kind: "tool-call",
    name: "command",
    summary: "pnpm lint",
    detail: "src/a.ts\n  3:7  error  'x' is assigned a value but never used",
    status: "failed",
    exit_code: 1,
  }),
  event("activity-command", "test", 3, 3_000, {
    kind: "tool-call",
    name: "command",
    summary: "pnpm test --reporter=tap",
    detail: TEST_OUTPUT,
    status: "running",
  }),
  event("activity-command", "status", 4, 3_100, { kind: "status-changed", status: "running" }),
];

const liveEvents: SessionEvent[] = [
  event("activity-live", "user", 1, 1_000, { kind: "user-message", text: "按图片调整装备对比提示。" }),
  event("activity-live", "narration", 2, 2_000, {
    kind: "agent-message",
    phase: "commentary",
    text: "我会按图片调整装备对比提示的评分颜色、箭头和替换按钮，此次使用 unity-ui-ugui 技能。",
  }),
  event("activity-live", "mcp", 3, 3_000, {
    kind: "tool-call",
    name: "execute_code",
    summary: "MCP Unitymcp execute_code",
  }),
  event("activity-live", "found", 4, 4_000, {
    kind: "agent-message",
    phase: "commentary",
    text: "已找到装备对比组件和普通详情入口。当前替换按钮使用固定控制。详情预制体已有本地修改，我会保留这些内容。",
  }),
  event("activity-live", "think", 5, 5_000, { kind: "thinking", text: "思考中…" }),
  event("activity-live", "status", 6, 5_100, { kind: "status-changed", status: "running" }),
];

const BEIGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABjklEQVR42u3bQU7DQBBE0cqcCiSOjwQHYYnEFViwIwqK7a4qo/xeRV5E1c9xYvdMLl+fH6Ju14IAIIAAAggggAACiAIIIIAAAggggACiAAIIIIAAAggggCiAAAIIIIAeB+j97bXe0myGNZ6sazSeYTnOW8vIkWGZPtV5I1OG5bvmk0a+DMuULGlkzbB8yTJG7gzLmsxtFMiwH+jp+aV7f7TpPTelHbvEikYZnYEv6YpRTGfmZz5slNQZu1GMGYV1Jh81AkZ5neGHVatRRWd+3GEyaunIMTAbNyrqyDRRHDTq6sg3ch0xquvIOpM+aHQGHbmH9ruNTqKjwKrGDqPz6Ei6ZP7Ua5p4uHUUWxdzdBLQUXLhcLafjI7CK6tTXcV0lF96Pt5bUkeVtfkjHYZ11Nq8sK/PvI6Kuzu2dlvRUXf7y/09t3RU3x903fk9Rx4I6Ff/P6+vjzw00B8udZ3cs9j/LfYoAgQQQAABBBBAAFEAAQQQQAABBBBAFEAAAQQQQAABBBAFEEAAAQTQmesb0pm39HD0bFAAAAAASUVORK5CYII=";
const PURPLE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABkElEQVR42u3asa3CQBCE4eX6ISJ/pdABbVAYORENEbwMBML2zsxJ/jdCDtDsBwf27R0u52tRn2tAABBAAAEEEEAAAUQBBBBAAAEEEEAAUQABBBBAAAEEEEAUQAABBBBA+wG6P27xlnozjPZkWaP2DEPxuaWMFBmG6FvtNxJlGLo17zTSZRiiZE4jaYahS+YxUmcY0mRqI0OG9UCn41/2/mjRey5K27bEgkYenYYf6YiRTafnb95s5NRpu1G0GZl1Oh81DEZ+neaHValRRKd/u0NklNIpxYZZu1FQp0Q7io1GWZ3Sbbm2GMV1SronvdFoBp1Sb9qvNppEpwxTjRVG8+iUZ+yjuz9S65RtLqboxKBTzsFhbz8enTJPVru6sumUf/S8vTenTkVm81s6NOtU6vDCuj79OhU83bG024hOZY+//N5zSqfi54PeO//lyo6AXvr/f/1+ZddAX1ziOjXPEbzZVtZ0QNMWQAABBBBAAAEEEEAUQAABBBBAAAEEEAUQQAABBBBAAAFEAQQQQABF6wlrzbMRJqciOgAAAABJRU5ErkJggg==";
const SAND =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAABjUlEQVR42u3bMVLDQBBE0fYeDzgucAZyIm5DQIbLlCVNd4vyn8ilwNXzZNnS7Pry9fkh6nYtCAACCCCAAAIIIIAogAACCCCAAAIIIAoggAACCCCAAAKIAggggAAC6HGAXt/e6y3NZljjybpG4xmW47y1jBwZlulTnTcyZVi+az5p5MuwTMmSRtYMy5csY+TOsKzJ3EaBDPuBXp6fuvdHm95zU9qxS6xolNEZ+JKuGMV0Zn7mw0ZJnbEbxZhRWGfyUSNglNcZfli1GlV05scdJqOWjhwDs3Gjoo5ME8VBo66OfCPXEaO6jqwz6YNGZ9CRe2i/2+gkOgqsauwwOo+OpEvmT72miYdbR7F1MUcnAR0lFw5n+8noKLyyOtVVTEf5pefjvSV1VFmbP9JhWEetzQv7+szrqLi7Y2u3FR11t7/c33NLR/X9Qded33PkgYB+9f/z+vrIQwP94VLXyT2L/d9ijyJAAAEEEEAAAQQQBRBAAAEEEEAAAUQBBBBAAAEEEEAAUQABBBBAAJ25vgGelrZ37KT2HAAAAABJRU5ErkJggg==";

const imageEvents: SessionEvent[] = [
  event("activity-images", "user", 1, 1_000, { kind: "user-message", text: "看一下这几张界面。" }),
  event("activity-images", "view-2", 2, 2_000, {
    kind: "tool-call",
    name: "image",
    summary: "界面.png",
    images: [BEIGE, PURPLE],
  }),
  event("activity-images", "view-1", 3, 3_000, {
    kind: "tool-call",
    name: "image",
    summary: "单张.png",
    images: [SAND],
  }),
  event("activity-images", "status", 4, 3_100, { kind: "status-changed", status: "running" }),
];

const doneEvents: SessionEvent[] = [
  event("activity-done", "user", 1, 1_000, { kind: "user-message", text: "验收链接里标记已修复的缺陷。" }),
  event("activity-done", "narration", 2, 2_000, {
    kind: "agent-message",
    phase: "commentary",
    text: "我已经查看了当前页面的缺陷表格，并通过 Chrome 和 Unitymcp 集成执行了相关操作。",
  }),
  event("activity-done", "think-1", 3, 3_000, { kind: "thinking", text: "先核对表格选区。" }),
  event("activity-done", "mcp-chrome", 4, 4_000, {
    kind: "tool-call",
    name: "browser_snapshot",
    summary: "MCP Chrome browser_snapshot",
  }),
  event("activity-done", "mcp-unity", 5, 5_000, {
    kind: "tool-call",
    name: "execute_code",
    summary: "MCP Unitymcp execute_code",
  }),
  event("activity-done", "think-2", 6, 6_000, { kind: "thinking", text: "再看复制操作。" }),
  event("activity-done", "cmd-1", 7, 7_000, { kind: "tool-call", name: "command", summary: "检查了表格选中" }),
  event("activity-done", "cmd-2", 8, 8_000, { kind: "tool-call", name: "command", summary: "查看了表格复制操作" }),
  event("activity-done", "cmd-3", 9, 9_000, {
    kind: "tool-call",
    name: "command",
    summary: "复制了缺陷记录选中（只读）",
  }),
  event("activity-done", "answer", 10, 10_000, {
    kind: "agent-message",
    phase: "final-answer",
    text: "当前表格中有一个缺陷记录被选中。我检查了选中状态，查看了可用的表格复制操作，并成功复制了选中的缺陷记录（只读模式）。",
  }),
  event("activity-done", "status", 11, 10_100, { kind: "status-changed", status: "completed" }),
];

function Frame({
  id,
  title,
  status,
  events,
}: {
  id: string;
  title: string;
  status: SessionStatus;
  events: SessionEvent[];
}) {
  const current = session(id, title, status);
  return (
    <div data-activity-frame={id} className="h-[70vh] min-h-0 border-b border-wb-border">
      <PreviewSession session={current} events={events} profiles={ACTIVITY_PREVIEW_PROFILES} />
    </div>
  );
}

/** 开发预览：进行中末行写此刻在做什么和用时，结束后不留。`?preview=activity` */
export default function ActivityPreview() {
  return (
    <div className="h-screen w-screen overflow-auto bg-wb-surface text-wb-fg">
      <Frame id="activity-live" title="正在思考" status="running" events={liveEvents} />
      <Frame id="activity-done" title="思考已结束" status="completed" events={doneEvents} />
      <Frame id="activity-images" title="已查看图像" status="running" events={imageEvents} />
      <Frame id="activity-command" title="命令进行中" status="running" events={commandEvents} />
    </div>
  );
}
