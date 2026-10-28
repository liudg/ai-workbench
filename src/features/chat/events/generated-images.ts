import type { SessionEvent } from "../../../types/index.ts";

/** 生成结果留在对话正文，查看图片仍属于过程。语义由适配器提供。 */
export function hasGeneratedImages(event: SessionEvent): boolean {
  return event.kind === "tool-call"
    && event.name === "image_generation"
    && (event.images?.length ?? 0) > 0;
}
