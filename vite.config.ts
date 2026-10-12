import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Tauri 期望固定的开发端口；4573 避开常见端口冲突
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
