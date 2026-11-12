import type { ReactNode } from "react";

export function BrandHeader({ action }: { action?: ReactNode }) {
  return (
    <header
      data-sidebar-brand=""
      className="flex h-12 shrink-0 items-center justify-between gap-2 px-3 pt-1"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <BrandMark />
        <span className="truncate text-[13.5px] font-semibold tracking-tight text-wb-fg">
          AI 工作台
        </span>
      </div>
      {action ? <div className="flex shrink-0 items-center">{action}</div> : null}
    </header>
  );
}

function BrandMark() {
  return (
    <svg className="h-5 w-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="1.5"
        y="1.5"
        width="21"
        height="21"
        rx="6.5"
        className="fill-wb-accent-soft stroke-wb-accent"
        strokeWidth="1.75"
      />
      <path
        d="M7.25 8.75L10.75 12L7.25 15.25"
        fill="none"
        className="stroke-wb-accent"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.75 15.25H16.75"
        fill="none"
        className="stroke-wb-fg"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
