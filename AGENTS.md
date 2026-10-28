# AGENTS.md

## 项目目标
AI Workbench 是一个多 Agent 桌面工作台（Tauri + React），在同一个界面里驱动 Codex、Claude Code 等本地 Agent。借鉴 herdr、orca、t3code 的好设计，目标是比 v1 更好用。

## 架构
- 后台常驻 `aiwb-daemon`（`crates/`）持有项目、任务、会话和 Agent，SQLite 是唯一数据源；前端经 WebSocket JSON-RPC 直连它（`src/lib/daemon`），桌面版和网页预览走同一条通道。
- Tauri 应用壳（`src-tauri/`）只做原生能力：拉起 daemon、窗口、托盘、通知和任务栏角标、内置浏览器、本机打开和图片。前端调用壳的地方都在 `src/lib/native`。
- 详细设计和迁移记录见 `docs/architecture-v2.md`。

## 多 Agent 规则
- 换 Agent 不需要改 UI：界面完全由当前会话适配器的数据和能力驱动，不用 Agent 名字判断能力。
- 模型、强度、权限、服务档位等目录来自各自的适配器或 CLI，不跨 Agent 串用。
- 能力开关只有在该 Agent 原生确实不支持时才能关；新增或修改适配器时，逐项用真实的原生 CLI 验证，支持的全部实现。

## 设计来源
- 新功能和交互只从两处来：v1 已有的、参考项目（herdr、orca、t3code，源码在 `Z:\workbench`）有的。
- 借鉴参考项目时以源码为准，在文档里写明出处（项目和文件）。

## 代码规则
- 按职责和耦合拆模块。
- 展示组件不直接调用 invoke、backend 或全局 store，数据进出走该功能的 hook 或 service。
- 不跨功能模块深层引用；shared 不依赖任何 feature，store 不依赖 feature 的 UI。
- 不重复写同一份状态或 UI；删掉死代码、兼容垫片、没接上的控件和没人用的 export。
- 不造假：不写假返回，不用空实现冒充已接通。

## 边界
- 界面文案不写解释实现原理的话。