# Clarify

无需部署服务器的极简 AI 待办软件（Windows 桌面，设计中）。

> 说一句就安排好，点一下就完成，24 小时后消失。

## 当前状态

- **阶段**：产品定义第一轮讨论完成（2026-11-01）；开发前文档的写手暂未启动，等产品定义逐项确认后再写
- **最新权威记录**：[docs/00-product-decisions.md](docs/00-product-decisions.md)（产品定义讨论 v1.0）
- **核心澄清**：没有收件箱/标签/多状态；只有"未完成/已完成"；完成的 24h 内可恢复、之后物理删除；事件 = 动作标题 + 可选字段（时间/重复/计数）；显示模板 A 时间轴 / B 清单，可切换
- **下一步**：继续逐项讨论 §10 待定清单（先视觉细化 / 到时通知 / 数据备份），然后写 PRD、交互、领域模型与契约，再进入技术尖峰

## 文档索引

| 文件 | 内容 |
|---|---|
| [docs/00-product-decisions.md](docs/00-product-decisions.md) | **产品定义讨论记录 v1.0（当前权威）** |
| [docs/00-charter.md](docs/00-charter.md) | 项目宪章/术语表（v1.0，部分条款已被产品决策更新，待 v1.1） |
| [docs/10-risks-decisions.md](docs/10-risks-decisions.md) | 决策登记与风险登记（D/R 系列） |
| [docs/design-v0.3.md](docs/design-v0.3.md) | 历史设计稿（AI 架构已更正，产品定义以 00-product-decisions 为准） |
| [docs/design-v0.2.md](docs/design-v0.2.md) / [v0.1](docs/design-v0.1.md) | 历史版本 |
| [docs/prototype-v0.1.html](docs/prototype-v0.1.html) | 旧可点击线框（已过时：仍含收件箱/标签/多状态，待按新定义重做） |
| [docs/research/tech-stack.md](docs/research/tech-stack.md) | 技术选型研究（桌面壳/本机 ASR 部分有效） |
| [docs/research/product-ux.md](docs/research/product-ux.md) | 产品交互研究（部分被新决策取代） |
| [docs/adr/0001-ai-service-model.md](docs/adr/0001-ai-service-model.md) | ADR-0001 草案：AI 能力提供方式 |
| [docs/ops/official-ai-gateway-setup.md](docs/ops/official-ai-gateway-setup.md) | 官方 AI 服务注册/部署指南 |

## 产品一句话

想到一件事 → 全局快捷键说一句 → 本机转写 + 云端 AI 理解成"动作 + 字段" → 直接落到视图（无缓冲区）；点一下完成；已完成 24h 内可见可恢复、之后物理删除；悬浮窗是可移动可缩放的精致小组件。

## 技术方向（待 spike 验证）

Tauri 2（Rust 原生层）+ React 前端 + SQLite；本机录音 + 云端 ASR（默认候选阿里实时）+ DeepSeek `deepseek-flash` 解析；官方轻量网关（阿里云函数计算）为主，BYOK/规则模式兜底；无账号、无自建服务器、无遥测。
