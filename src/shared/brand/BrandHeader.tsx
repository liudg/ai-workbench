import styles from "./brand.module.css";

export function BrandHeader() {
  return (
    <header className={styles.frame} data-sidebar-brand="">
      <div className={styles.panel}>
        <div className={styles.lockup}>
          <BrandMark />
          <span className={styles.wordmark}>One</span>
        </div>
        <p className={styles.tagline}>所有 agent，一处协作</p>
      </div>
    </header>
  );
}

function BrandMark() {
  return (
    <svg className={styles.mark} viewBox="0 0 26 26" aria-hidden="true">
      <rect x="1" y="1" width="24" height="24" rx="7" fill="none" stroke="#4f8dff" strokeWidth="2.2" />
      <path
        d="M7 9l4 4-4 4"
        fill="none"
        stroke="#4f8dff"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M13.5 17.5h5.5" fill="none" stroke="#e8e8e8" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
