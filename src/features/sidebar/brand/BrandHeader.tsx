import { Search } from "lucide-react";

import { COMMAND_MENU_COPY, OPEN_COMMAND_MENU } from "@/features/command-menu";
import styles from "./brand.module.css";

export function BrandHeader() {
  return (
    <header className={styles.frame} data-sidebar-brand="">
      <div className={styles.panel}>
        <div className={styles.lockup}>
          <BrandMark />
          <span className={styles.wordmark}>One</span>
        </div>
        <button
          type="button"
          className={styles.quickSearch}
          aria-label={COMMAND_MENU_COPY.open}
          aria-keyshortcuts="Control+K Control+Shift+P"
          title={`${COMMAND_MENU_COPY.title} (${COMMAND_MENU_COPY.shortcutOpen})`}
          onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_MENU))}
        >
          <Search className={styles.searchIcon} strokeWidth={2} aria-hidden="true" />
          <kbd className={styles.shortcut}>{COMMAND_MENU_COPY.shortcutOpen}</kbd>
        </button>
      </div>
    </header>
  );
}

function BrandMark() {
  return (
    <svg className={styles.mark} viewBox="0 0 26 26" aria-hidden="true">
      <rect
        x="1"
        y="1"
        width="24"
        height="24"
        rx="7"
        fill="var(--wb-accent-muted)"
        stroke="var(--wb-accent)"
        strokeWidth="1.8"
      />
      <path
        d="M7.5 9.5l3.8 3.5-3.8 3.5"
        fill="none"
        stroke="var(--wb-accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.5 16.5h5"
        fill="none"
        stroke="var(--wb-text-strong)"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
