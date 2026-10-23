// 发布构建前编译 daemon，按 Tauri sidecar 的命名（带目标三元组）放进 src-tauri/binaries。
// 开发时不走这里：应用直接用 cargo target 目录里的 daemon。
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
if (!host) throw new Error("rustc -vV 没有给出 host");

execFileSync("cargo", ["build", "--release", "-p", "aiwb-daemon"], { cwd: root, stdio: "inherit" });

const ext = process.platform === "win32" ? ".exe" : "";
const outDir = join(root, "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
copyFileSync(join(root, "target", "release", `aiwb-daemon${ext}`), join(outDir, `aiwb-daemon-${host}${ext}`));
