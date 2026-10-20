/**
 * 公开的 latest.json。空字符串表示还没有更新源。
 * 有真实 HTTPS 地址时，这里和 tauri.conf.json 的 plugins.updater.endpoints 写成同一个地址。
 */
export const UPDATE_ENDPOINT = "";

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
