# Clarify 交接手册（Handover）

- Owner：Lead
- 版本：v0.1
- 更新：2026-11-01
- 用途：新人/新 AI 代理在 1 天内接手 Clarify 开发前资产的入口。

## 0. 先读什么（顺序）

1. `docs/00-product-decisions.md`（**产品定义最高权威 v1.1**）
2. `docs/00-charter.md`（v1.1：理念/范围/术语）
3. `docs/10-risks-decisions.md` + `docs/01-prd.md §8`（决策台账/开放问题）
4. `docs/01-prd.md` → `docs/02-ux-spec.md`（需求/交互）
5. `docs/03-domain-model.md` + `docs/05-contracts/*`（数据/契约）
6. `docs/04-architecture.md` + `docs/06-adr/*`（技术/决策）
7. `docs/07-test-strategy.md`、`docs/09-roadmap-wbs.md`、`docs/11-release-ops.md`
8. `docs/08-engineering.md`（怎么干活）、`docs/12-visual-spec.md` + `prototype-v0.2.html`（视觉）
9. `docs/handover/critic-review-1.md`（红队审查：P0/P1/P2）

## 1. 项目一句话

无服务器、极简的 Windows 桌面 AI 待办：热键说一句 → 云端 ASR + DeepSeek 解析成"动作标题 + 明确字段" → 直接落视图（无收件箱）→ 点圈完成 → 已完成所有视图底部折叠 24h → 之后物理删除。无通知、无首启引导、无备份导出。

## 2. 当前环境（本机实测 2026-11-01）

| 项 | 状态 |
|---|---|
| Windows | 11 22H2（22621） |
| Node | v24.15.0（已装） |
| pnpm | 10.33.2（已装） |
| Git | 2.54（已装） |
| Python | 3.11.5（已装，可用于工具脚本） |
| WebView2 Runtime | 156.x（已装） |
| **Rust stable（rustup）** | **未装**（M1 前需装） |
| **VS Build Tools / MSVC** | **未装**（Tauri Windows 编译需要） |
| 磁盘 | C: 约 215GB 可用 |

## 3. 关键命令（详见 08-engineering.md）

```bash
pnpm install                 # 安装前端依赖（首次）
pnpm tauri dev               # 启动 Tauri 开发（M1 后）
pnpm test                    # 前端测试
pnpm eval:rules              # 评估集：规则解析基线
pnpm eval:ai                 # 评估集：真实 AI（需 Key，不跑 CI）
cargo test --manifest-path src-tauri/Cargo.toml
pnpm lint && pnpm format:check
```

> 仓库尚未初始化工程骨架（`src/`、`src-tauri/`、`gateway/` 待 M1 创建）；当前仓库只有文档、评估集与视觉原型。

## 4. 目录约定

- `docs/`：事实源文档（编号 00~12、契约、ADR、评估集、handover）
- `docs/handover/`：审查报告、性能记录、测试记录
- `docs/prototype-v0.2.html`：视觉初稿（浏览器直接打开）
- `gateway/`（待建）：阿里云函数计算网关（Node 20）
- `src/` + `src-tauri/`（待建）：Tauri 2 + React 前端 / Rust 原生层
- `eval/`（待建，产出目录）：评估 runner 与运行结果

## 5. 当前状态与阻塞项（G0）

- 文档 Phase 0B 完成；红队 P0/P1 已修大部分（见 critic-review-1；P0-01/02/03 已处理，P0-04 待用户确认 Q9）。
- 视觉初稿 v0.2 完成，待用户调整（`12-visual-spec.md §14 A1–A12`）。
- **G0（进入 M1 前）还需**：用户确认 Q1/Q8/Q9/Q10/Q13/Q20/Q21/Q27（见 `01-prd.md §8` / `10-risks-decisions.md §3`）；剩余 P1 关闭 ≥90%；本手册 + 环境就绪。
- 环境缺口：Rust/MSVC 未安装；安装后先跑 Tauri 空壳 + Spike S4（悬浮窗组合行为）。

## 6. 第一周建议

1. 装 Rust stable + VS Build Tools（C++ 桌面开发负载）。
2. 跑 Spike S4（Tauri 无边框透明置顶悬浮窗 + 拖动/缩放/多屏/全屏隐藏）——不达标切 Electron 的决策点。
3. 跑 S1（ASR 三家对比，需账号）/ S3（DeepSeek JSON 质量，需 Key）。
4. 通过后建骨架：SQLite schema/migrations、事件 CRUD、完成/恢复、24h 清理、设置、官方网关客户端；再进 UI。
5. 每个 PR 按 `08-engineering.md` 的 checklist；改行为必须同步文档。

## 7. 秘密与账号

- 真实 Key/激活码**只能**在作者本地或云函数环境变量；不写入仓库、不写日志。
- 需要作者操作：阿里云（ASR + 函数计算）、DeepSeek 账号与充值；详见 `docs/ops/official-ai-gateway-setup.md`。
- 用户数据只在本机 SQLite；无备份/导出，删除不可恢复（已获用户确认）。

## 8. 文档 Owner 台账

| 文档 | Owner |
|---|---|
| 00-product-decisions / 00-charter / 10-risks / ADR | Lead |
| 01-prd / 02-ux-spec | 产品（Lead 复核） |
| 03-domain-model / 05-contracts/storage / eval | 领域（开发复核） |
| 04-architecture / 05-contracts 其余 / 08-engineering | 技术（开发复核） |
| 07-test / 09-roadmap / 11-release | 质量/PMO（Lead 复核） |
| 12-visual-spec / prototype | 视觉（Lead 复核） |
