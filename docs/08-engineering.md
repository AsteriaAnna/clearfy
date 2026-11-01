# 工程规范（Engineering）

- Owner：tech-writer（技术与工程文档）
- 版本：v0.2（红队修复稿；v0.1 初稿）
- 更新日期：2026-11-01
- 本次修订（v0.2）：P0-03 工程约束——新增 §0 时间/路径原则、§1 边界纪律（Clock、DB 路径）、§3.1/§3.2 测试注入与 `lint:guards` 守门、§5 PR checklist 两条（时间必须走 Clock、禁止硬编码 DB 路径）、§6 CI 守门说明。修订章节：§0、§1、§3.1、§3.2、§5、§6、§12。
- 状态：**开发前工程基线**。目录/工具链/脚本/分支/CI/秘密/文档规则以本文为准；构建与发布细节以 `11-release-ops.md` 为准；测试门禁以 `07-test-strategy.md` 为准。
- 关联：`04-architecture.md`（模块边界）、`05-contracts/*`（契约）、`09-roadmap-wbs.md`（里程碑与任务）、`docs/handover/README.md`（交接）

---

## 0. 原则

1. **一个仓库**：客户端（前端 + Rust + 网关）同一仓库、同一 PR 可跨层修改契约。文档即事实源，代码跟随。
2. **小步可运行**：每个合并到 `main` 的提交都应可构建、可测试；里程碑内保持"每周可运行版本"（charter §11）。
3. **契约先行**：涉及 `05-contracts/*` 的改动必须先改文档/契约，再实现，同一 PR 内完成，不允许"先写代码后补文档"。
4. **无秘密进仓库**：Key/激活码/证书/签名私钥一律不进 Git、不进构建产物、不进日志（charter §10）。
5. **Windows 为唯一 v1 目标**：CI/本地均以 Windows x64 为准；跨平台代码保持可移植但不做 macOS 验收。
6. **零遥测**：不接入任何统计/崩溃上报 SDK；依赖引入需经 license/隐私审查。
7. **时间与路径可测**：业务时间一律经注入的 `Clock`（禁止模块直调 `SystemTime::now`/`Utc::now`/`Local::now`）；DB 路径唯一常量在 `app` 启动层，禁止其他模块硬编码；测试用 `FakeClock` + `maintenance.run`（仅 debug）与 `CLARIFY_ENV`/`CLARIFY_DB_PATH` 隔离（见 04 §3.5、05-config §10.4）。

---

## 1. 仓库结构

```
clarify/
├─ README.md / CHANGELOG.md / LICENSE / .gitignore / .editorconfig
├─ package.json                 # 根：前端 + Tauri CLI + 脚本（pnpm workspace 根）
├─ pnpm-workspace.yaml          # packages: [".", "gateway"]
├─ pnpm-lock.yaml
├─ tsconfig.json                # 前端 TS 配置（strict）
├─ vite.config.ts               # 多入口：主窗 index.html / 悬浮窗 overlay.html
├─ eslint.config.js / .prettierrc / rustfmt.toml
│
├─ docs/                        # 全部文档（事实源，见 §8）
│  ├─ 00~11、05-contracts/、06-adr/、research/、ops/、eval/、handover/
│
├─ src/                         # React 前端（仅展示/交互，不网络/不落盘）
│  ├─ main/                     # 主窗入口 index.html + 一个主页面 + 设置页 + 详情抽屉
│  ├─ overlay/                  # 悬浮窗入口 overlay.html（独立小组件）
│  ├─ shared/                   # ipc 客户端、事件订阅、Event 显示规则（03-domain §4）、组件
│  └─ styles/                   # Tailwind 入口、设计 tokens（视觉待定）
│
├─ src-tauri/                   # Rust 原生层（Tauri 2）
│  ├─ src/
│  │  ├─ app/                   # 启动/单实例/模块装配/生命周期 + DB 路径唯一常量（04 §6.1）
│  │  ├─ clock/                 # Clock trait + SystemClock/FakeClock（唯一时间来源，04 §3.5）
│  │  ├─ db/                    # rusqlite actor、迁移（storage-schema §3.3 薄 runner）、视图查询 SQL
│  │  ├─ capture/               # cpal 录音、重采样、VAD、内存 WAV
│  │  ├─ asr/                   # AsrProvider：官方网关 / BYOK 直连（待 S1）
│  │  ├─ ai/                    # 模式/能力决策、ParseProvider、规则解析、AI JSON 校验
│  │  ├─ scheduler/             # 24h 物理删除、计数边界、启动/唤醒对账
│  │  ├─ window/                # 主窗/悬浮窗、几何、透明度/材质与降级
│  │  ├─ shortcut/              # 全局热键注册/冲突
│  │  ├─ credentials/           # Windows 凭据管理器（keyring + secrecy）
│  │  ├─ settings/              # 设置加载/校验/迁移/合并
│  │  ├─ ipc/                   # commands/events、capabilities、错误信封
│  │  ├─ logging/               # 本地日志 + 脱敏
│  │  └─ error/                 # AppError、错误码、网关错误映射
│  ├─ migrations/               # 版本化 SQL（文件内含事务，薄 runner；禁止修改已发布迁移）
│  ├─ capabilities/             # Tauri 2 窗口权限（main / widget 两套 JSON）
│  ├─ icons/ / tauri.conf.json / Cargo.toml / build.rs
│  └─ rust-toolchain.toml       # 固定 Rust stable 版本
│
├─ gateway/                     # 阿里云 FC 官方轻量网关（Node 20）
│  ├─ src/                      # index/router/auth/quota/providers/usage/log
│  ├─ test/                     # 契约测试（mock 上游，不联网）
│  ├─ esbuild.config.mjs        # 打包为单文件 CJS（target node20）
│  ├─ s.yaml                    # Serverless Devs 部署描述
│  ├─ package.json / tsconfig.json / .env.example
│  └─ VERSION                   # 网关独立版本号（与 health/字段同步）
│
├─ spike/                       # 可丢弃验证代码（不进入生产构建）
│  ├─ spk-win/                  # 悬浮窗组合行为（透明/置顶/拖拽/缩放/DPI）
│  ├─ s1-asr/                   # ASR 供应商对比录音/脚本（音频 gitignore）
│  ├─ s2-gateway/               # 网关冷启动/配额/预算验证
│  ├─ s3-parse/                 # 解析延迟/准确率采样
│  └─ README.md                 # 每个 spike 的问题/方法/阈值/结论（结论同步 research/spike-results.md）
│
├─ eval/                        # 可执行评估 runner 与结果（样本在 docs/eval/）
│  ├─ run.mjs                   # 规则/云端两种模式；输出指标 JSON
│  └─ runs/                     # 历史报告（小体积 JSON/Markdown，可提交）
│
├─ scripts/                     # 版本校验、许可清单、db 重置、激活码生成（本地）
└─ .github/workflows/           # ci / eval-nightly / release / gateway-deploy
```

**边界纪律**：

- `src/`（前端）**禁止**：直接 `fetch`/`WebSocket`、读写文件、访问注册表、持有 Key、调用系统 API；一切经 `invoke`/事件。
- `src-tauri/` 业务模块遵循 `04-architecture.md` §4.2 依赖方向；跨模块通信走接口/事件，不共享可变全局。
- **时间**：只有 `clock/` 模块可以触碰系统时钟；其他模块接收注入的 `Clock`（`now_utc/local_date/local_week_key`），业务边界判定全部在 Rust 侧。
- **DB 路径**：唯一常量在 `app/` 启动层（`%LOCALAPPDATA%\app.clarify.desktop\clarify.db`，04 §6.1）；`db/` 及其他模块只接收注入路径；测试经 `CLARIFY_DB_PATH`（config-schema §10.4），禁止任何模块硬编码路径。
- `gateway/` 不引用客户端代码；契约类型各自维护但字段名以 `05-contracts/gateway-api.md` 为准。
- `spike/` 代码允许丢弃，但必须能复现结论；不得被生产构建引用。

---

## 2. 工具链版本

| 工具 | 版本/要求 | 说明 |
|---|---|---|
| Windows | Windows 11 22H2+（开发/验收）；Windows 10 21H2+（兼容测试 VM） | x64；v1 不做 ARM64 |
| Visual Studio Build Tools | VS 2022，工作负载「使用 C++ 的桌面开发」（MSVC v143 + Windows 10/11 SDK） | Tauri/Rust MSVC 工具链前置 |
| Rust | **stable（MSVC）**，由 `src-tauri/rust-toolchain.toml` 固定；随 Tauri 2 官方 MSRV | 组件：`rustfmt`、`clippy` |
| Node.js | **24.x LTS**（前端构建/工具/评估 runner） | `.node-version` + `package.json engines` 固定 |
| pnpm | **10.x**（`packageManager` 固定，Corepack 启用） | 禁止 npm/yarn 混用 |
| TypeScript | 7.0.x（strict） | 前端与 gateway 各自 tsconfig |
| Vite / React / Tailwind | Vite 8.3.x / React 19.3.x / Tailwind 4.3.x | 见 04-architecture §10 |
| Tauri CLI | 2.12.x（`@tauri-apps/cli`，root devDependency） | 与 Rust `tauri` crate 版本一致（`check:versions` 校验） |
| WebView2 Runtime | Evergreen（开发机必须安装；Win11 预装） | 最终用户由安装包 bootstrapper 处理 |
| 网关运行时 | **阿里云 FC Node.js 20**（生产）；构建目标 node20 | 本地开发用 Node 24 跑源码，产物按 node20 打包 |
| Serverless Devs | 最新 3.x（`@serverless-devs/s` 全局或 npx） | 部署 gateway；凭据走环境变量/本地 profile |
| 质量工具 | `cargo-deny`、`cargo-audit`、`gitleaks`、ESLint、Prettier | CI 强制（§6） |
| Git | 2.40+；Windows 建议 `git config core.longpaths true` | 路径长度 |

**版本升级规则**：工具链/依赖升级单独 PR（`chore(deps)`），必须说明理由、跑完整 CI + 冒烟；Tauri/React/Rust 大版本升级需 ADR 或 Lead 批准。

---

## 3. 本地开发

### 3.1 首次环境准备

1. 安装 VS 2022 Build Tools（C++ 桌面工作负载）、WebView2 Evergreen Runtime。
2. 安装 rustup：`winget install Rustlang.Rustup`；进入仓库后由 `rust-toolchain.toml` 自动装 stable + rustfmt/clippy。
3. 安装 Node 24 LTS，`corepack enable`，`corepack prepare pnpm@10 --activate`。
4. `git config core.longpaths true`（Windows 路径）。
5. `pnpm install`（仓库根，自动装前端与 gateway）。
6. 复制 `.env.example` → `.env.local`（开发用测试 Key；**不提交**）。开发/测试库隔离：`CLARIFY_ENV=dev|test` + `CLARIFY_DB_PATH`（**仅 dev/test 生效，生产忽略**；见 `05-contracts/config-schema.md` §10.4）。
7. `pnpm dev` → 启动主窗 + 悬浮窗；或 `pnpm dev:web` 只在浏览器调试 UI（IPC 用 mock）。

### 3.2 常用脚本（`package.json`，root）

| 命令 | 作用 | 备注 |
|---|---|---|
| `pnpm dev` | `tauri dev`：Vite + Rust 热重载 | 需要 WebView2 |
| `pnpm dev:web` | 仅 `vite`，浏览器预览（mock IPC） | 不能验证窗口/录音 |
| `pnpm build:web` | `vite build`（双入口资源） | CI 用 |
| `pnpm tauri build` | 生成 NSIS 安装包（release） | 发布用完整命令（见 11-release-ops） |
| `pnpm test` | 前端 + Rust + gateway 全部单测 | 提交前必跑 |
| `pnpm test:web` | `vitest run` | 组件/显示规则/IPC mock |
| `pnpm test:rust` | `cargo test`（src-tauri） | 领域规则/迁移/清理/视图 |
| `pnpm test:gateway` | gateway 契约测试（mock 上游） | 不联网、不需要真实 Key |
| `pnpm lint` | clippy(`-D warnings`) + rustfmt check + ESLint + Prettier check | CI 同步 |
| `pnpm format` | `cargo fmt` + `prettier --write` | 提交前 |
| `pnpm typecheck` | 前端与 gateway `tsc --noEmit` | |
| `pnpm eval:rules` | 离线规则解析跑 `docs/eval/`（确定性） | **PR 门禁**，<60 s |
| `pnpm eval:ai` | 云端 AI 跑评估集（需 `.env.local` 测试 Key） | 手动/夜间；有成本上限 |
| `pnpm gateway:dev` | 本地 8787 端口跑网关（mock/测试凭据） | 客户端 `gateway_url` 可指本机 |
| `pnpm gateway:build` | esbuild 打包 `gateway/dist`（node20） | 部署产物 |
| `pnpm gateway:deploy` | Serverless Devs 部署（需云凭据） | 仅 Lead/授权者 |
| `pnpm check:versions` | 校验 app/db schema/contract/gateway 版本一致性 | CI 必跑 |
| `pnpm check:licenses` | cargo-deny licenses + 前端许可清单 | CI 必跑（§6） |
| `pnpm db:reset` | **仅开发** 清空开发库（守卫 `CLARIFY_ENV=dev`） | 防止误伤用户数据 |
| `pnpm lint:guards` | `rg` 守门：时间只能经 `clock/`；DB 路径不得硬编码（04 §3.5/§6.1） | CI `lint` 阶段调用 |
| `pnpm spike:<name>` | 运行 `spike/` 下验证脚本 | 结果写 `docs/research/spike-results.md` |

> 脚本名以本表为契约；新增脚本需同步本表。`11-release-ops.md` 引用的构建命令为 `pnpm tauri build`，不得替换为别名。

---

## 4. 分支与提交规范

### 4.1 分支模型（trunk-based）

- `main`：唯一长期分支，受保护；始终可构建、CI 绿；只通过 PR 合入（squash merge，保持线性历史）。
- 短分支（生命周期 ≤ 几天，合并后删除）：
  - `feat/<scope>-<简述>`、`fix/<scope>-<简述>`、`docs/<简述>`、`chore/<简述>`、`test/<简述>`、`spike/<编号>-<简述>`。
- `spike/*`：允许丢弃质量；**结论**必须落 `docs/research/spike-results.md`，代码不进入 `main`（除被提炼的适配层）。
- 发布：`main` 打 tag `v<X.Y.Z>`（见 11-release-ops §3）；不使用 release 分支。
- 多人协作：同一文件/契约避免并行长分支；契约类改动先合文档再并行实现。

### 4.2 提交信息（Conventional Commits）

```
<type>(<scope>): <中文摘要，≤50 字>

<原因与做法；可多行>

Refs: #<issue/任务号>
Docs: <受影响文档路径，若无写 "none">
Test: <测试/评估证据>
```

- `type`：`feat|fix|docs|test|refactor|perf|build|ci|chore|spike`。
- `scope`：`app|db|capture|asr|ai|scheduler|window|widget|shortcut|settings|ipc|gateway|contracts|docs|eval|ci|deps`。
- 破坏性变更：`type(scope)!:` + footer `BREAKING CHANGE: <影响>`；契约破坏性变更还必须按各契约文档版本策略执行。
- 提交粒度：一个逻辑变更一个提交；禁止"WIP/fix typo 堆叠"直接进 `main`。格式化提交与逻辑提交分开（可选）。
- 禁止：提交真实音频/截图含隐私、`.env`、数据库文件、构建产物、个人绝对路径。

---

## 5. 代码审查（PR）Checklist

> `main` 的每个 PR 必须由非作者审查（1 名开发时由 Lead/AI 代理交叉审查）；以下项由作者自查 + 审查者确认，**不勾选不得合并**。

- [ ] 变更范围与关联任务一致；PR 描述含：做了什么、为什么、如何验证、影响面。
- [ ] **行为变更已同步文档**（PRD/UX/领域/契约/测试/路线图中受影响者）；`00-product-decisions.md` 未被违背（v1.1 为唯一权威）。
- [ ] 契约变更已更新对应文档并记变更记录：`gateway-api` / `tauri-ipc` / `config-schema` / `error-taxonomy` / `ai-json`。
- [ ] 新增错误码已在 `05-contracts/error-taxonomy.md` 登记并给出中文文案、可重试性、降级动作。
- [ ] 新增设置字段已进 `config-schema.md`（Schema + 默认值 + 迁移规则）；新 IPC 命令已进 `tauri-ipc.md` + `capabilities/`（按窗口白名单）。
- [ ] 数据/schema 变更：迁移在事务内、版本单调、含迁移样本测试；**无备份可回滚**，必须证明旧数据不被破坏。
- [ ] **时间必须走 `Clock`**：不新增 `SystemTime::now()`/`Utc::now()`/`Local::now()` 直调（`clock/` 除外）；24h/跨日/跨周用例在 `FakeClock` 或 `maintenance.run`（仅 debug）下演示，不真实等待（04 §3.5）。
- [ ] **禁止硬编码 DB 路径**：路径只来自 `app` 启动层唯一常量（04 §6.1）；测试用 `CLARIFY_ENV`/`CLARIFY_DB_PATH` 注入，不触碰生产库。
- [ ] 测试：新增/修改逻辑有单测；领域规则对照 `03-domain-model.md` §12 用例；网关契约测试覆盖错误码/配额边界。
- [ ] AI 相关（prompt/模型/供应商/JSON 契约）已跑 `pnpm eval:ai` 并附报告；未达标不得默认启用。
- [ ] 性能预算核对（热键/端到端/内存/包体，见 04-architecture §7）；可疑项附测量数据。
- [ ] 隐私/安全：日志不含正文/音频/Key/激活码；无遥测；无明文秘密；新增网络出口在白名单内。
- [ ] 依赖变更通过 `cargo-deny`/`pnpm audit`/许可检查；新增依赖说明用途与许可证。
- [ ] `pnpm lint && pnpm test` 本地通过；无 `--no-verify` 跳过钩子。
- [ ] UI 改动附截图/录屏（主窗 + 悬浮窗；浅色至少一档；DPI 100%/150% 如涉及窗口）。
- [ ] 回滚/降级方案：失败时用户数据是否安全、是否可恢复、是否影响已发布契约。
- [ ] 文档链接可点、术语一致（Event/动作标题/A 模板/B 模板/未完成-已完成）。
- [ ] 无调试残留：临时日志、TODO 需带负责人与任务号、注释掉的代码、测试 Key。

**评审礼仪**：评论就事论事；作者 24 h 内响应；P0 问题未关闭不得合并；紧急修复可走快车道但事后 48 h 内补测试与文档。

---

## 6. CI（GitHub Actions，`windows-latest`）

### 6.1 阶段（`.github/workflows/ci.yml`，PR + push main）

| # | 阶段 | 内容 | 失败门禁 | 预算 |
|---|---|---|---|---|
| 1 | setup | Node 24 + pnpm(cache) + Rust(cache) + WebView2（仅需要运行时） | 安装失败 | 2 min |
| 2 | `lint` | `cargo fmt --check`、`cargo clippy -- -D warnings`、`pnpm lint:guards`（时间/DB 路径守门）、ESLint、Prettier、`tsc --noEmit`（前端+gateway） | 任一失败 | 4 min |
| 3 | `test` | `cargo test`、`vitest run`、gateway 契约测试（mock 上游） | 单测失败/覆盖核心规则回归 | 8 min |
| 4 | `build` | `vite build` + `cargo check`（debug，不打包安装包） | 构建失败 | 6 min |
| 5 | `eval-rules` | `pnpm eval:rules`（离线、确定性） | 指标低于 `docs/eval/README.md` 基线 | 1 min |
| 6 | `contract` | 网关契约测试子集 + `check:versions` + OpenAPI/JSON Schema 校验（如有） | 错误码/配额/版本不一致 | 3 min |
| 7 | `security` | `gitleaks`、`cargo-audit`、`cargo-deny`（licenses/advisories）、`pnpm audit --prod` | 发现问题（可配置 ignore 清单，必须写理由+到期日） | 4 min |

- 所有 job 在 Windows runner 上跑（单平台，避免 Linux/Windows 行为差异导致的假绿）。
- **时间/路径守门（`pnpm lint:guards`，04 §3.5/§6.1）**：用 `rg` 断言 `src-tauri/src/clock/**` 之外不出现 `SystemTime::now|Utc::now|Local::now`；`src-tauri/src/app/**` 之外不出现硬编码 `clarify.db`/`LOCALAPPDATA`/生产 DB 路径；命中即失败（允许清单需 PR 说明并登记）。
- 24h/周期边界测试用 `FakeClock` + 仅 debug 注册的 `maintenance.run{now_override?}`（tauri-ipc §4.18），禁止真实 `sleep`；DB 隔离用 `CLARIFY_ENV=test` + `CLARIFY_DB_PATH`（config-schema §10.4）。
- 缓存：`~/.cargo`、`src-tauri/target`、pnpm store；key 含 `Cargo.lock`/`pnpm-lock.yaml` 哈希。
- 依赖机器：不使用 self-hosted（v1）；单次 CI 总预算 ≤25 min。
- 测试与诊断产物：失败时上传日志；**不得上传用户数据/音频**（CI 内无真实用户数据）。

### 6.2 其他工作流

| 工作流 | 触发 | 内容 | 约束 |
|---|---|---|---|
| `eval-nightly.yml` | 每日定时 + 手动 | `pnpm eval:ai` 完整评估集；报告上传 artifact + 更新 `eval/runs/`（如有变更由 bot/PR） | 需 Secrets；成本上限（评估条数×单价，≤¥5/次）；失败告警给 Lead |
| `release.yml` | tag `v*`（手动审批） | `pnpm tauri build`（release）→ 冒烟 → 生成签名/`latest.json`/SHA256 → GitHub Release | 受保护 environment、审批人必须非作者；细节见 11-release-ops §2 |
| `gateway-deploy.yml` | 手动 dispatch（审批） | `pnpm gateway:build` → 契约测试 → Serverless Devs 部署 → `GET /v1/health` 冒烟 | 仅 Lead/授权者；staging 无独立环境时先在本地 mock 全绿再发；部署后记录版本 |
| `docs-check.yml`（P1） | PR（路径过滤 docs/） | Markdown 链接检查 + 契约文档 schema 语法校验 | 可先警告不阻塞 |

### 6.3 门禁与例外

- **PR 必须全绿才能合并**（§6.1 全部阶段）。不允许用"再跑一次"掩盖 flaky：flaky 测试须标记并限时修复（72 h），期间可 quarantine（单独 job 记录）。
- 热修复：允许 revert 后重新提交；不允许绕过 CI 直接推 `main`（仓库分支保护开启，含管理员）。
- 发布门禁额外要求：`07-test-strategy.md` 的发布冒烟全过 + AI eval 最近一次达标报告 + 无 P0/P1 未关闭缺陷（11-release-ops）。

---

## 7. 秘密与安全

### 7.1 红线

- 仓库、Git 历史、Issue/PR/文档示例、安装包、日志、崩溃转储中**不得出现**任何真实 Key/激活码/证书/签名私钥/用户音频。（`docs/` 中一律用 `CLR-XXXX-XXXX-XXXX`、`sk-****` 占位。）
- `.env*`（除 `.env.example` 占位）进 `.gitignore`；`gateway/.env.local`、`src-tauri` 本地测试库、`spike/audio/`、`eval/runs/**/raw/` 同理。
- 前端构建产物不得内联任何秘密；官方网关地址非秘密，但厂商 Key 仅存在服务端。
- 禁用遥测/统计 SDK（新增依赖需 Lead 审查）。

### 7.2 秘密存放位置

| 秘密 | 存放 | 备注 |
|---|---|---|
| 官方网关厂商 Key（DeepSeek/ASR） | 阿里云 FC 环境变量（FC 控制台，建议 RAM 角色 + KMS 加密） | 仅作者/Lead 可见；轮换后重新部署 |
| 激活码哈希列表 / HMAC 盐 | FC 环境变量 `ACTIVATION_CODE_HASHES`/`ACTIVATION_CODE_HMAC_SECRET` | 修改 = 配置变更（可吊销） |
| OSS 访问凭据 | **优先** FC RAM 角色（无静态 AK）；否则 FC 环境变量 | 最小权限（仅 usage/budget 前缀读写） |
| 内测激活码明文 | 作者本地密码管理器 + `scripts/gen-activation.mjs` 生成（不提交） | 按人分发、可作废 |
| BYOK / 测试用 DeepSeek、百炼 Key | `.env.local`（开发机）/ GitHub environment secrets（eval CI） | 使用低额度测试账号 |
| 更新签名私钥（Tauri updater/minisign） | 离线密码管理器/硬件介质 + GitHub environment secret（仅 release） | 泄露 = 更新通道信任失效（11 §RB-03） |
| 阿里云部署凭据（Serverless Devs） | GitHub `gateway-deploy` environment secrets 或本地 profile | 最小权限 RAM 用户 |
| 代码签名证书 | 公开分发前另行决策（当前 v1 不签名） | 见 11-release-ops §1.4 |

### 7.3 轮换与泄漏响应

1. 发现泄漏（`gitleaks`/人工）：立即作废对应凭据（吊销激活码批次、轮换厂商 Key、回收更新私钥）→ 重新部署/发版 → 记录事件与影响 → 补门禁规则。
2. 轮换节奏：厂商 Key 至少每 6 个月或人员变更时；激活码 HMAC 盐轮换需重算白名单（造成旧码失效，提前公告）。
3. 日志排障：只能凭 `request_id`/`trace_id`；不得临时打开 body 日志（代码层禁止结构上就无法打印）。
4. 本地开发使用独立测试凭据，禁止用作者生产 Key 跑开发。

### 7.4 仓库设置

- 开启 GitHub Secret Scanning / Push Protection；分支保护（含管理员）要求 CI 绿 + 1 审查；`main` 禁止 force push。
- Actions 权限最小化：默认 `permissions: contents: read`；发布/部署 job 单独提权并对受保护 environment 设审批。
- Dependabot（或 Renovate）仅提 PR，不自动合并。

---

## 8. 文档更新规则

### 8.1 单一事实源（改行为必改文档）

| 事实 | 唯一 Owner 文档 |
|---|---|
| 产品行为/范围/不做清单 | `00-product-decisions.md`（权威）→ `01-prd.md`/`02-ux-spec.md` |
| 领域字段/状态/生命周期/视图规则 | `03-domain-model.md` |
| AI 输入输出/提取规则/版本 | `05-contracts/ai-json.md` |
| SQLite 存储 | `05-contracts/storage-schema.md` |
| 客户端 IPC 命令/事件 | `05-contracts/tauri-ipc.md` |
| 官方网关 HTTP | `05-contracts/gateway-api.md` |
| 设置结构/默认值/凭据 | `05-contracts/config-schema.md` |
| 错误码/文案/降级 | `05-contracts/error-taxonomy.md` |
| 架构/模块/性能/安全 | `04-architecture.md` |
| 测试与门禁 | `07-test-strategy.md` |
| 计划/WBS | `09-roadmap-wbs.md` |
| 工程/CI/秘密 | `08-engineering.md`（本文） |
| 发布/运营/合规 | `11-release-ops.md` |
| 决策依据 | `06-adr/*`、`10-risks-decisions.md` |

### 8.2 规则

1. **PR 内同步**：改行为/契约/字段/错误码/设置 → 同 PR 更新对应文档与变更记录表；不同步不合并（charter §10）。
2. **契约版本**：`gateway-api` 破坏性变更走 `/v2` + `MIN_APP_VERSION`；`ai-json` 按 MAJOR/MINOR 策略；`config-schema` 变更字段升 `schema_version` 并写迁移；`tauri-ipc` 与客户端同版本发（不承诺跨版本）。
3. **ADR**：影响架构/依赖/成本/隐私/壳选型/供应商的决定必须新增或更新 ADR（背景/选项/决定/后果），并在 `10-risks-decisions.md` 登记。
4. **术语**：统一用 `03-domain-model.md` 术语（Event/动作标题/完成日志/周期边界/悬浮窗）；禁止文档间自造同义词。
5. **链接**：文档间用相对路径 Markdown 链接；新增文档需更新 `README.md` 索引与相关文档的"关联"行。
6. **评审节奏**：每个里程碑结束做红队审查（一致性/遗漏/可执行性），问题清单落 `docs/handover/` 并关闭；任何 spike 结束 → Go/No-Go 记入 `10-risks-decisions.md` §2。
7. **文档 v0.1 → 评审 → 冻结**：本文与契约文档冻结后，变更需按版本策略与变更记录维护，不允许静默改语义。
8. **禁止**：文档中写真实秘密/真实用户数据；承诺未实现的行为（除明确标注"待 spike/待确认"）。

---

## 9. 版本与发布工程（摘要，完整见 `11-release-ops.md`）

- 版本唯一来源：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` 三处一致（`pnpm check:versions` 校验）；安装包版本 = `latest.json` 版本。
- 独立版本号分别记录（见 11 §3.3）：App 版本（SemVer）、DB `schema_version`、AI 契约版本、网关 `VERSION`。
- 构建：干净环境 `pnpm install --frozen-lockfile && pnpm tauri build`；禁止手工拼包发布。
- 发布产物：`Clarify_<version>_x64-setup.exe`、`*.sig`（启用更新时）、`latest.json`、SHA256；流程与回滚见 11-release-ops §1/§2。
- CI 生成而非开发机生成发布产物；构建后校验版本/大小（<80 MB，见 04-architecture §7）/启动冒烟。

---

## 10. 交接（Handover）

- 交接入口：`docs/handover/README.md`（**待建**，M0/M1 内由 Lead/开发建立），必须包含：
  1. 环境准备（§3.1 一键步骤）；
  2. 构建/运行/测试/发布命令清单（§3.2、§9）；
  3. 网关部署与回滚、配额/预算调整、激活码生成与吊销；
  4. 秘密保管位置与轮换流程（§7，不写明文）；
  5. 已知问题、风险与待确认项索引（`10-risks-decisions.md`、各文档"待定"；
  6. 故障排查：错误码→日志→`request_id` 路径。
- 红队/评审问题清单：`docs/handover/critic-review-*.md`；
- Spike 结论：`docs/research/spike-results.md`（每次 spike 更新）；
- **交接演练 DoD**：一名未参与开发的人，仅凭文档在 1 个工作日内完成：搭环境 → `pnpm dev` → `pnpm test` → 本地跑通网关 → 出一个安装包；全程提问 ≤3 个且均能在文档中找到答案。里程碑结束时演练一次。
- 人员/职责与决策权见 `00-charter.md` §7；未决策项不得口头承诺。

---

## 11. 待确认/待建

| # | 项 | 归属/时机 |
|---|---|---|
| G1 | 仓库托管与命名（GitHub 私有仓库名/组织） | Lead，M0 |
| G2 | `eval/run.mjs` 具体指标算法与门禁阈值 | 以 `docs/eval/README.md` 与 `07-test-strategy.md` 为准（M0-06） |
| G3 | 前端测试覆盖率门禁（Rust/前端阈值） | `07-test-strategy.md` 定；本文不另立 |
| G4 | `handover/README.md` 初版 | Lead/开发，M0 结束前 |
| G5 | 代码签名、自动更新是否进 v1 | 11-release-ops / 09-roadmap 决定（P1） |
| G6 | 内测包分发渠道（GitHub Release 私有 / 网盘 + SHA256） | Lead，M4 |

---

## 12. 变更记录

| 版本 | 日期 | 变更 | 作者 |
|---|---|---|---|
| v0.1 | 2026-11-01 | 首版：仓库结构、工具链版本、脚本表、分支/提交规范、PR checklist、CI 阶段、秘密管理、文档更新规则、交接要求 | tech-writer |
| v0.2 | 2026-11-01 | 红队修复（P0-03）：§0/§1 增加时间（Clock）与 DB 路径边界；§3.1 测试库注入；§3.2 新增 `lint:guards`；§5 PR checklist 增两条；§6 CI 增守门说明 | tech-writer |
