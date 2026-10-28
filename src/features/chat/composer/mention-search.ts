import { userFacingMessage } from "../../../lib/user-facing.ts";

/** 路径筛选的一页。`ready` 为 false 时索引还在建。 */
export interface PathPage {
  paths: readonly string[];
  truncated: boolean;
  cancelled: boolean;
  ready: boolean;
}

export interface PathFollow {
  paths: readonly string[];
  truncated: boolean;
  ready: boolean;
}

const PAGE_GAP_MS = 40;

/** 筛选失败时只留一句给人看的话。占位错误和异常原文不进菜单。 */
export function mentionSearchError(error: unknown): string {
  return userFacingMessage(error) ?? "文件列表没有读到。";
}

/**
 * 路径索引边扫边返回。`ready` 之前继续要下一页，
 * 取消的页不交给调用方，也不能当成最终结果。
 */
export async function followPathPages(
  load: () => Promise<PathPage>,
  onPage: (page: PathFollow) => void,
  cancelled: () => boolean,
  wait: (ms: number) => Promise<void> = waitMs,
  maxHops = 20000,
): Promise<void> {
  for (let hop = 0; hop < maxHops; hop += 1) {
    if (cancelled()) return;
    const page = await load();
    if (cancelled() || page.cancelled) return;
    onPage({ paths: page.paths, truncated: page.truncated, ready: page.ready });
    if (page.ready) return;
    await wait(PAGE_GAP_MS);
  }
  throw new Error("筛选没有完成");
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
