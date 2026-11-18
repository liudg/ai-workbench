# AGENTS.md

AI Workbench 是一个多 Agent 桌面工作台（Tauri + React），在同一个界面里驱动本机的 Codex、Claude Code、Cursor Agent 等 CLI。

## 常用命令
- `pnpm build`：tsc 类型检查加前端构建
- `pnpm test`：前端测试，测试文件和源码放在一起（`*.test.ts(x)`）
- `cargo test -p <crate>`：Rust 测试。标了 `#[ignore]` 的 live 测试会调用本机已安装并登录的 CLI，加 `-- --ignored` 运行
- 网页预览：先 `cargo run -p aiwb-daemon`，再 `pnpm dev`，然后打开 http://localhost:4573
- 桌面版：`pnpm tauri:dev`

## 架构
- `crates/aiwb-daemon`：常驻后台，持有项目、任务、会话和 Agent。SQLite（`aiwb-store`）是唯一数据源。
- `crates/aiwb-agents`：各 Agent 的适配器（`codex/`、`claude/`、`cursor/`、`acp/` 等），公共协议在 `protocol/`。
- `crates/aiwb-core`：共享模型，包括事件、目录和时间线。另外还有 `aiwb-git`、`aiwb-files`、`aiwb-proc`。
- 前端经 WebSocket JSON-RPC 直连 daemon（`src/lib/daemon`），桌面版和网页预览走同一条通道。
- `src-tauri/` 只做原生能力：拉起 daemon、窗口、托盘、通知和角标、内置浏览器、本机打开、图片。前端只通过 `src/lib/native` 调用它。
- 前端按功能分在 `src/features/<功能>`，跨功能只从对方的 `index.ts` 导入。`src/shared` 不依赖任何 feature，`src/store` 不依赖 feature 的 UI。

## 多 Agent
- 界面只由当前会话适配器上报的数据和能力驱动，不按 Agent 名字写分支。接入新 Agent 不应该需要改界面。
- 模型、推理强度、权限、服务档位等目录来自各自的适配器或 CLI，不跨 Agent 混用。
- 只有原生 CLI 确实不支持时才能关掉某项能力。新增或修改适配器时，要逐项用真实 CLI 验证。

## 完成标准
交付前按顺序做完：
1. 改了前端：`pnpm build` 和 `pnpm test` 通过。
2. 改了 Rust：涉及的 crate 的 `cargo test -p` 通过。改了适配器的，还要跑对应的 live 测试或用真实 CLI 验证。
3. 改了界面或交互：启动 daemon 和网页预览，亲手操作确认生效。用到原生能力的走 `pnpm tauri:dev`。
4. 自己过一遍 diff，看有没有超出需求的改动、重复实现或残留代码。

汇报时说清楚跑了哪些检查、结果是什么，没验证到的要明说。
