import type { ComponentType, SVGProps } from "react";

/** 新标签页：线框地球，圆、经线和赤道。 */
export const NewTabIcon: ComponentType<SVGProps<SVGSVGElement>> = ({ className }) => (
  <svg viewBox="0 0 16 16" className={className} fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="5.25" stroke="currentColor" strokeWidth="1.3" />
    <ellipse cx="8" cy="8" rx="2.35" ry="5.25" stroke="currentColor" strokeWidth="1.3" />
    <path d="M2.75 8h10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
