import { transport } from "../transport";
import { attachments } from "./call";
import type { Backend } from "./contract";

export const pickCommands: Pick<
  Backend,
  "pickDirectory" | "pickPreviewFile" | "pickImageFiles" | "pickFiles" | "pickMentionFiles"
> = {
  pickDirectory: async (title) => {
    const [selected] = await transport.pick({ directory: true, multiple: false, title });
    return selected ?? null;
  },
  pickPreviewFile: async () => {
    const [selected] = await transport.pick({ directory: false, multiple: false, title: "再打开文件" });
    return selected ?? null;
  },
  pickImageFiles: async () =>
    attachments(
      await transport.pick({
        directory: false,
        multiple: true,
        title: "添加照片和文件",
        filters: [
          {
            name: "图片",
            extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"],
          },
        ],
      }),
    ),
  pickFiles: async () =>
    attachments(await transport.pick({ directory: false, multiple: true, title: "添加附件" })),
  pickMentionFiles: async () =>
    attachments(
      await transport.pick({ directory: false, multiple: true, title: "文件和文件夹" }),
    ),
};
