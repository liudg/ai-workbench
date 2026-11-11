export function PreviewPending() {
  return <p className="px-4 py-6 text-sm text-[var(--wb-muted)]">正在读取…</p>;
}

export function PreviewFailed({ message }: { message: string }) {
  return <p className="px-4 py-6 text-sm text-[var(--wb-danger-text)]">{message || "无法读取文件"}</p>;
}
