// 看板的列和卡片。纯数据，不碰连接。

import {
  attentionQueue,
  BOARD_COLUMNS,
  boardColumn,
  type Attention,
  type BoardColumn,
} from "../../shared/attention/attention.ts";

/** 「空闲」列最多摆这么多张，再多的从侧栏找。 */
export const IDLE_LIMIT = 20;

export interface BoardTask {
  id: string;
  projectId?: string;
  title: string;
  archivedAt?: number;
  attention: Attention;
}

export interface BoardLane<T> {
  column: BoardColumn;
  cards: T[];
  /** 没摆出来的张数。 */
  hidden: number;
}

/** 归档的不上看板。「要你处理」按注意力队列排，其他列最近动过的在前。 */
export function buildBoard<T extends BoardTask>(tasks: readonly T[]): BoardLane<T>[] {
  const live = tasks.filter((task) => !task.archivedAt);
  return BOARD_COLUMNS.map((column) => {
    const cards = live.filter((task) => boardColumn(task.attention) === column);
    if (column === "needs-you") return { column, cards: attentionQueue(cards), hidden: 0 };
    cards.sort((a, b) => b.attention.updatedAt - a.attention.updatedAt);
    if (column === "idle" && cards.length > IDLE_LIMIT) {
      return { column, cards: cards.slice(0, IDLE_LIMIT), hidden: cards.length - IDLE_LIMIT };
    }
    return { column, cards, hidden: 0 };
  });
}
