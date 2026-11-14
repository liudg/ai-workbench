/**
 * 公开的 latest.json 更新源地址。
 * 须与 src-tauri/tauri.conf.json 的 plugins.updater.endpoints 保持一致。
 */
export const UPDATE_ENDPOINT =
  "https://github.com/liudg/ai-workbench/releases/latest/download/latest.json";

export function configuredUpdateEndpoint(endpoint = UPDATE_ENDPOINT): string | null {
  const value = endpoint.trim();
  if (!value || /OWNER\/REPO/i.test(value) || !value.startsWith("https://")) return null;
  return value;
}

export function updateFailureIsMissingSource(message: string): boolean {
  return (
    /OWNER\/REPO/i.test(message) ||
    /empty endpoint/i.test(message) ||
    /any endpoints set/i.test(message) ||
    /no updater endpoint/i.test(message)
  );
}

/** 将底层英文网络、远端清单与签名错误转换为面向用户的简洁中文提示。 */
export function formatUpdaterError(raw: unknown, stage: "check" | "install"): string {
  const text =
    typeof raw === "string" ? raw : raw instanceof Error ? raw.message : "";
  const trimmed = text.trim();

  if (/could not fetch a valid release json/i.test(trimmed)) {
    return "暂未获取到可用发布版本，请稍后再试。";
  }
  if (
    /signature|minisign|pubkey|key id|signed for version|requiresignedversion/i.test(
      trimmed,
    )
  ) {
    return "更新包签名校验未通过，请稍后再试。";
  }
  if (
    /download request failed|error sending request|timed? ?out|dns|connect|network|connection|tls|certificate|status:\s*\d{3}/i.test(
      trimmed,
    )
  ) {
    return stage === "check"
      ? "网络连接异常，无法检查更新。"
      : "下载更新包失败，请检查网络后重试。";
  }
  if (/[\u4e00-\u9fff]/.test(trimmed)) {
    return trimmed;
  }
  return stage === "check"
    ? "暂时无法检查更新，请稍后再试。"
    : "更新未能完成，请稍后再试。";
}
