import { DESKTOP_ZH } from "./strings/desktop-zh";

/** 优先用剪贴板 API；被拒绝时退回选区复制。两者都失败就抛出真实原因。 */
export async function writeClipboardText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 权限被拒绝时改用选区。
    }
  }
  if (typeof document === "undefined") throw new Error(DESKTOP_ZH.diffCopyFailed);
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.focus();
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error(DESKTOP_ZH.diffCopyFailed);
}

/** 同时放纯文本和 HTML，贴进富文本编辑器时保留格式。写不了 HTML 时只放纯文本。 */
export async function writeClipboardRich(text: string, html: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return;
    } catch {
      // 退回纯文本。
    }
  }
  await writeClipboardText(text);
}
