# Clarify

本地优先的极简 AI 协作待办软件（Windows 桌面，规划中）。

> 说一句就安排好，点一下就完成，24 小时后自动消失。

## 当前状态

- **阶段**：设计讨论（v0.2），等待拍板 9 项关键决策
- **已完成**：产品定义、对象模型/状态机、关键链路、悬浮窗与主窗口页面地图、AI JSON 契约、技术选型（含 14 项技术尖峰清单）、开发路线
- **下一步**：拍板决策 → 写 ADR → 技术尖峰 Spike A（Tauri 悬浮窗 / 全局热键 / 本地 ASR / 本地 LLM 解析）→ 线框走查

## 文档索引

| 文件 | 内容 |
|---|---|
| [docs/design-v0.2.md](docs/design-v0.2.md) | 主设计稿（当前版本，讨论用） |
| [docs/design-v0.1.md](docs/design-v0.1.md) | 上一版设计稿（已被 v0.2 取代，保留历史） |
| [docs/prototype-v0.1.html](docs/prototype-v0.1.html) | 可点击线框：主窗口 / 悬浮窗 / 捕捉条（浏览器打开） |
| [docs/research/tech-stack.md](docs/research/tech-stack.md) | 技术选型研究报告（2026-11-01） |
| [docs/research/product-ux.md](docs/research/product-ux.md) | 产品与交互研究报告（2026-11-01） |
| `docs/adr/` | 架构决策记录（拍板后写入，待建） |
| `docs/research/spike-results.md` | 技术尖峰实测结果（待建） |

## 产品一句话

想到一件事 → 全局快捷键说一句 → 本地 AI 转写并解析成结构化待办（自动排期、可拆多件）→ 零确认创建；完成只需一次点击；已完成 24 小时后从视野消失，悬浮窗永远清晰。

## 技术方向（待 spike 验证后定稿）

Tauri 2（Rust 主进程）+ 独立 AI 侧车进程（sherpa-onnx ASR + llama.cpp/Qwen3.5）+ React 前端 + SQLite；完全本地，无账号、无服务器、无遥测。

## 目录规划

```
clarify/
├─ docs/          # 设计、研究、ADR、线框
├─ src/           # 前端（React + TS + Vite；规划）
├─ src-tauri/     # Tauri 主进程（Rust；规划）
└─ engine/        # AI 侧车（Rust + C/C++；规划）
```
