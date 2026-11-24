// 全文检索摘要分词高亮与元数据展示辅助（纯函数，无 DOM / XSS 风险，不依赖任何 feature）。

export interface SnippetSegment {
  text: string;
  highlight: boolean;
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 按查询词（空白切分、大小写无关、长词优先）将摘要切分为普通文本与高亮片段。
 * 保留原文大小写，字面量 `[[` / `]]`、正则元字符与 HTML 标签均原样保留为纯文本节点。
 */
export function parseSnippetSegments(snippet: string, query: string): SnippetSegment[] {
  if (!snippet) return [];

  const rawTerms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replace(/\*\*|`/g, ""))
    .filter((term) => term.length > 0);
  if (rawTerms.length === 0) {
    return [{ text: snippet, highlight: false }];
  }

  const seen = new Set<string>();
  const uniqueTerms: string[] = [];
  for (const term of rawTerms) {
    const lower = term.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    uniqueTerms.push(term);
  }
  uniqueTerms.sort((a, b) => b.length - a.length);

  const pattern = new RegExp(uniqueTerms.map(escapeRegExp).join("|"), "gi");
  const segments: SnippetSegment[] = [];
  let cursor = 0;

  for (let match = pattern.exec(snippet); match !== null; match = pattern.exec(snippet)) {
    const start = match.index;
    const matchedText = match[0];
    if (matchedText.length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    if (start > cursor) {
      segments.push({ text: snippet.slice(cursor, start), highlight: false });
    }
    segments.push({ text: matchedText, highlight: true });
    cursor = start + matchedText.length;
  }

  if (cursor < snippet.length) {
    segments.push({ text: snippet.slice(cursor), highlight: false });
  }

  return segments.length > 0 ? segments : [{ text: snippet, highlight: false }];
}

export function searchHitRoleLabel(role: string): string {
  switch (role) {
    case "title":
      return "标题";
    case "user":
      return "用户";
    case "assistant":
      return "助手";
    default:
      return "消息";
  }
}

export function resolveSearchProjectName(
  projectId: string | null | undefined,
  projects: readonly { id: string; name: string }[],
): string {
  if (!projectId) return "聊天";
  const found = projects.find((project) => project.id === projectId);
  return found?.name.trim() || "项目";
}
