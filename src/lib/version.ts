import pkg from "../../package.json";

/** 当前应用版本（与 tauri.conf.json / Cargo.toml 保持一致） */
export const APP_VERSION: string = pkg.version;
