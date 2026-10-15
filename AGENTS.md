# AGENTS.md

## 项目目标
AI Workbench 是一个多 Agent 桌面工作台（Tauri + React），在同一个界面里驱动 Codex、Claude Code 等本地 Agent，交互体验对标 Codex 桌面端。

## 多 Agent 规则
- 换 Agent 不需要改 UI：界面完全由当前会话适配器的数据和能力驱动，不用 Agent 名字判断能力。
- 共享能力走适配器 trait、capabilities 和归一化事件；新的预览类型走 viewer registry。
- 模型、强度、权限、服务档位等目录来自各自的适配器或 CLI，不跨 Agent 串用。
- 能力开关只有在该 Agent 原生确实不支持时才能关；新增或修改适配器时，逐项用真实的原生 CLI 验证，支持的全部实现。

## 对标 Codex 的规则
- 对齐 Codex 的结论必须来自本机（liudong-win）用 rea 分析真实 Codex 安装包的输出，不只凭截图或记忆。
- 有 openai/codex 官方对应物的功能，跟官方逻辑和 app-server API 走，不另写一套协议。
- rea 看不到的部分标「未观察」，不实现；不凭空发明 Codex 没有的功能。

## 代码规则
- 按职责和耦合拆模块，不按文件大小拆。
- 展示组件不直接调用 invoke、backend 或全局 store，数据进出走该功能的 hook 或 service。
- 不跨功能模块深层引用；shared 不依赖任何 feature，store 不依赖 feature 的 UI。
- 不重复写同一份状态或 UI；删掉死代码、兼容垫片、没接上的控件和没人用的 export。
- 不造假：不写假返回，不用空实现冒充已接通。

## 边界
- 整理代码时不改已经验收的产品交互，不带来视觉回归。
- 界面文案不写解释实现原理的话。