# Clarify

无需部署服务器的极简 AI 待办软件（Windows 桌面，规划中）。

> 说一句就安排好，点一下就完成，24 小时后自动消失。

## 关键澄清（v0.3）

"完全本地"在本项目里 = **不需要你部署任何服务器/后端**；AI 直接调用云端大模型 API（用你自己的 Key）。**不是"完全离线、模型都在本机"**。数据存本机；语音识别推荐本机跑（音频不出电脑），解析走云端。

## 当前状态

- **阶段**：设计讨论 v0.3，等待拍板 10 项关键决策
- **已完成**：产品定义、对象模型/状态机、关键链路、悬浮窗与主窗口页面地图、AI JSON 契约、技术选型（无服务器 + 云端 AI）、技术尖峰清单、开发路线、可点击线框
- **下一步**：拍板决策 → 写 ADR → 技术尖峰 Spike A（Tauri 悬浮窗 / 云端解析 / 本机 ASR / Key 配置与断网降级）→ 线框走查

## 文档索引

| 文件 | 内容 |
|---|---|
| [docs/design-v0.3.md](docs/design-v0.3.md) | **主设计稿（当前版本）** |
| [docs/design-v0.2.md](docs/design-v0.2.md) | 历史版本（按"完全离线"做的选型，已被 v0.3 更正） |
| [docs/design-v0.1.md](docs/design-v0.1.md) | 历史版本 |
| [docs/prototype-v0.1.html](docs/prototype-v0.1.html) | 可点击线框：主窗口 / 悬浮窗 / 捕捉条（浏览器打开） |
| [docs/research/tech-stack.md](docs/research/tech-stack.md) | 技术选型研究报告（桌面壳、本机 ASR 部分有效；本机 LLM 降为可选） |
| [docs/research/product-ux.md](docs/research/product-ux.md) | 产品与交互研究报告 |
| [docs/adr/0001-ai-service-model.md](docs/adr/0001-ai-service-model.md) | ADR-0001 草案：AI 能力由谁提供、API Key 放在哪（待拍板） |
| [docs/ops/official-ai-gateway-setup.md](docs/ops/official-ai-gateway-setup.md) | 官方 AI 服务的注册/部署操作指南（云函数、费用、合规） |
| `docs/research/spike-results.md` | 技术尖峰实测结果（待建） |

## 产品一句话

想到一件事 → 全局快捷键说一句 → 本机转写 + 云端 AI 解析成结构化待办（自动排期、可拆多件）→ 零确认创建；完成只需一次点击；已完成 24 小时后从视野消失，悬浮窗永远清晰。

## 技术方向（待 spike 验证后定稿）

Tauri 2（Rust 原生层）+ React 前端 + SQLite；本机 ASR（sherpa-onnx，可选）+ 云端 LLM（OpenAI-compatible，用户自带 Key，客户端直连）；无账号、无服务器、无遥测。

## 目录规划

```
clarify/
├─ docs/          # 设计、研究、ADR、线框
├─ src/           # 前端（React + TS + Vite；规划）
└─ src-tauri/     # Tauri 主进程（Rust；规划）
```
