# Clarify

无需部署服务器的极简 AI 待办软件（Windows 桌面，开发前准备中）。

> 说一句就安排好，点一下就完成，24 小时后消失。

## 当前状态

- **阶段**：开发前文档 + 红队审查 + 视觉 v0.3 完成；悬浮窗经 v0.4 重做、v0.5 细化（时间细线标记 / 下拉拉伸显示全部 / 计数可超额）（2026-11-01）；待你确认视觉收口与剩余产品决策后进入 M1
- **最新权威记录**：[docs/00-product-decisions.md](docs/00-product-decisions.md)（产品定义 v1.1 + 计数/悬浮窗补充）
- **核心定义**：无收件箱/标签/通知/首启引导/备份导出；只有"未完成/已完成"；完成 24h 内可恢复、之后物理删除；事件 = 动作标题 + 可选字段（时间/重复/计数）；显示模板 A 时间轴 / B 清单；主窗 = 一个主页面 + 设置；计数目标可超额、周期结束才过期
- **下一步**：你确认悬浮窗 v0.5 → 视觉 v1.0 冻结 + 文档同步 + ADR-0008 定稿 → 装 Rust/MSVC 环境 → Tauri 空壳 + Spike S4 → M1 后端与底层

## 文档索引

| 文件 | 内容 |
|---|---|
| [00-product-decisions.md](docs/00-product-decisions.md) | **产品定义讨论记录 v1.1（当前权威）** |
| [00-charter.md](docs/00-charter.md) | 项目宪章/术语表（v1.1，已按产品决策重写） |
| [01-prd.md](docs/01-prd.md) | PRD：F1~F12 功能、验收标准、指标、开放问题 |
| [02-ux-spec.md](docs/02-ux-spec.md) | 交互规范：页面地图、A/B 模板、状态矩阵、文案、快捷键 |
| [03-domain-model.md](docs/03-domain-model.md) | 领域模型：字段字典、两状态、重复/计数、用例、非法组合 |
| [04-architecture.md](docs/04-architecture.md) | 技术架构：进程/模块/数据流/性能预算/降级矩阵 |
| [05-contracts/](docs/05-contracts/) | 契约：AI JSON、网关 API、Tauri IPC、存储 schema、配置 schema、错误码 |
| [06-adr/](docs/06-adr/) | ADR-0001~0008（AI 服务/供应商/壳/数据删除/模板/密钥隐私/更新/视觉） |
| [07-test-strategy.md](docs/07-test-strategy.md) | 测试策略、AI 门禁、E2E、Go/No-Go |
| [08-engineering.md](docs/08-engineering.md) | 工程规范：仓库/工具链/脚本/CI/秘密管理 |
| [09-roadmap-wbs.md](docs/09-roadmap-wbs.md) | M0~M4 路线、WBS、依赖、DoD |
| [10-risks-decisions.md](docs/10-risks-decisions.md) | 决策登记（D 系列）与风险登记（R 系列） |
| [11-release-ops.md](docs/11-release-ops.md) | 发布/签名/更新/隐私/许可/运营 |
| [eval/](docs/eval/) | 62 条中文口语评估集 + 期望 JSON + 指标规范 |
| [12-visual-spec.md](docs/12-visual-spec.md)、[prototype-v0.5.html](docs/prototype-v0.5.html) | 视觉 v0.5（暖纸感+三主题；悬浮窗时间细线/下拉拉伸/计数可超额）；对比页 [widget-lab.html](docs/widget-lab.html) + [截图](docs/screenshots/) |
| [prototype-v0.4.html](docs/prototype-v0.4.html)、[v0.3](docs/prototype-v0.3.html)、[v0.2](docs/prototype-v0.2.html) | 历史视觉原型 |
| [docs/handover/](docs/handover/) | 红队审查报告、交接手册（进行中） |
| [research/](docs/research/) | 早期技术/产品研究（历史证据） |
| [design-v0.1~v0.3](docs/design-v0.3.md) | 历史设计稿（已被产品决策取代） |
| [prototype-v0.1.html](docs/prototype-v0.1.html) | 旧线框（已过时，待删/替换为 v0.2） |
| [ops/official-ai-gateway-setup.md](docs/ops/official-ai-gateway-setup.md) | 官方 AI 服务注册/部署指南 |

## 产品一句话

想到一件事 → 全局快捷键说一句 → 云端语音识别 + DeepSeek 理解成"动作 + 字段" → 直接落到视图（无缓冲区）；点一下完成；已完成 24h 内可见可恢复、之后物理删除；悬浮窗是可移动可缩放的精致小组件。

## 技术方向（待 spike 验证）

Tauri 2（Rust 原生层）+ React 前端 + SQLite；本机录音 + 云端 ASR（默认候选阿里实时）+ DeepSeek `deepseek-flash` 解析；官方轻量网关（阿里云函数计算）为主，BYOK/规则模式兜底；无账号、无自建服务器、无遥测。
