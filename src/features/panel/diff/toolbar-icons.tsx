/** 红绿并排差异。工具栏里用它表示差异视图切换。 */
export function SplitDiffIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
      <rect x="1.6" y="2.4" width="5.6" height="11.2" rx="1" fill="var(--wb-del-stat)" />
      <rect x="8.8" y="2.4" width="5.6" height="11.2" rx="1" fill="var(--wb-add-stat)" />
    </svg>
  );
}
