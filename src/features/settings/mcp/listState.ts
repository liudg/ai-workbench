import type { McpServerRow } from "@/types";

export interface McpAgentList {
  generation: number;
  rows: McpServerRow[];
  error: string | null;
  listing: boolean;
}

export interface McpListBook {
  agents: Partial<Record<string, McpAgentList>>;
}

export function emptyBook(): McpListBook {
  return { agents: {} };
}

export function visibleList(
  book: McpListBook,
  kind: string | null,
): { rows: McpServerRow[]; error: string | null; listing: boolean } {
  if (!kind) return { rows: [], error: null, listing: false };
  const agent = book.agents[kind];
  if (!agent) return { rows: [], error: null, listing: false };
  return { rows: agent.rows, error: agent.error, listing: agent.listing };
}

/** 每个 Agent 一份列表。`generation` 是这次请求的令牌，后来的请求会加一。 */
export function startList(
  book: McpListBook,
  kind: string,
  generation: number,
  refresh: boolean,
): McpListBook {
  const previous = book.agents[kind];
  return {
    agents: {
      ...book.agents,
      [kind]: {
        generation,
        rows: refresh ? previous?.rows ?? [] : [],
        error: null,
        listing: true,
      },
    },
  };
}

/** 操作成功后先改本地行，不等 CLI 列表。之后的刷新会整表替换。 */
export function patchRows(
  book: McpListBook,
  kind: string,
  patch: (rows: McpServerRow[]) => McpServerRow[],
): McpListBook {
  const current = book.agents[kind];
  if (!current) return book;
  return { agents: { ...book.agents, [kind]: { ...current, rows: patch(current.rows) } } };
}

export function finishList(
  book: McpListBook,
  kind: string,
  generation: number,
  result: { rows: McpServerRow[] } | { error: string },
): McpListBook {
  const current = book.agents[kind];
  if (!current || current.generation !== generation) return book;
  if ("error" in result) {
    return {
      agents: {
        ...book.agents,
        [kind]: { ...current, error: result.error, listing: false },
      },
    };
  }
  return {
    agents: {
      ...book.agents,
      [kind]: { ...current, rows: result.rows, error: null, listing: false },
    },
  };
}
