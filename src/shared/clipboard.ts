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
