# AGENTS.md

## 项目目标
AI Workbench 是一个多 Agent 桌面工作台（Tauri + React），在同一个界面里驱动 Codex、Claude Code 等本地 Agent，交互体验对标 Codex 桌面端。代码规则见 docs/REFACTOR_RULES.md。

## 多 Agent 规则
- 换 Agent 不需要改 UI：界面完全由当前会话适配器的数据和能力驱动。
- 模型、强度、权限、服务档位等目录来自各自的适配器或 CLI，不跨 Agent 串用。
- 能力开关只有在该 Agent 原生确实不支持时才能关；新增或修改适配器时，逐项用真实的原生 CLI 验证，支持的全部实现。

## 对标 Codex 的规则
- 对齐 Codex 的结论必须来自本机（liudong-win）用 rea 分析真实 Codex 安装包的输出，不只凭截图或记忆。
- rea 看不到的部分标「未观察」，不实现；不凭空发明 Codex 没有的功能。

## 产品文案
- 界面文案不写解释实现原理的话。