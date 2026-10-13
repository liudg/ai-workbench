/** 进入完整视图：四角向外。退出：四角向内。 */
export function FullViewIcon({ exit = false }: { exit?: boolean }) {
  const d = exit
    ? "M2.4 6.1h3.1V2.4M13.6 6.1h-3.1V2.4M2.4 9.9h3.1v3.7M13.6 9.9h-3.1v3.7"
    : "M6.1 2.4H2.4v3.7M9.9 2.4h3.7v3.7M6.1 13.6H2.4V9.9M9.9 13.6h3.7V9.9";
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PanelSquareIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
      <rect x="2.2" y="2.6" width="11.6" height="10.8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.2 2.6v10.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function FolderStackIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
      <path
        d="M2.2 5.2h4l1 1.1h6.4v6.2H2.2V5.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M4 3.4h3.4l.9 1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
