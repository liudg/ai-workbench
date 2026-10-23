import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import fs from "fs";
import path from "path";
import type { Plugin } from "vite";

// 网页预览没有 Tauri：读 daemon 写在数据目录里的 daemon.json，把地址交给前端。
// daemon 要先手动启动：cargo run -p aiwb-daemon
function daemonEndpoint(): Plugin {
  const dataDir =
    process.env.AIWB_DATA_DIR ??
    path.join(
      process.env.APPDATA ??
        (process.platform === "darwin"
          ? path.join(process.env.HOME ?? "", "Library/Application Support")
          : process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "", ".local/share")),
      "com.aiworkbench.app",
    );
  return {
    name: "aiwb-daemon-endpoint",
    configureServer(server) {
      server.middlewares.use("/__daemon/endpoint", (_req, res) => {
        try {
          const info = JSON.parse(fs.readFileSync(path.join(dataDir, "daemon.json"), "utf8"));
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ url: `ws://127.0.0.1:${info.port}/ws`, token: info.token }));
        } catch {
          res.statusCode = 503;
          res.end("daemon 没有运行：cargo run -p aiwb-daemon");
        }
      });
    },
  };
}

// Tauri 期望固定的开发端口；4573 避开常见端口冲突
export default defineConfig({
  plugins: [react(), tailwindcss(), daemonEndpoint()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  clearScreen: false,
  server: {
    port: 4573,
    strictPort: true,
    host: "127.0.0.1",
    // 网页预览经 dev bridge 连真实后端：cargo run --features dev-bridge --bin dev-bridge
    proxy: {
      "/__bridge": { target: "http://127.0.0.1:4574", changeOrigin: false },
    },
  },
  build: {
    // Tauri 在 Windows 上使用 Chromium，在 macOS/Linux 上使用 WebKit
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
