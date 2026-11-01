# Clarify 技术架构（Architecture）

- Owner：tech-writer（技术与工程文档）
- 版本：v0.2（红队修复稿；v0.1 初稿）
- 更新日期：2026-11-01
- 本次修订（v0.2，按红队报告 ①）：P0-03 新增 §3.5「时间与可测性」（Clock 注入 / maintenance 触发 / DB 路径注入）；P1-01 §6.1 将 DB 路径定稿为唯一事实源；P1-02 §6.2 修正计数生命周期（无完成日志、不写 `completed_at`、无 24 h 删除）；P1-05 §5.6 标注额度重置权威；P1-06 录音上限口径统一为 15 s（§3.4/§4.1/§5.2）；P1-09 §6.1/§7 保留期引用 11；P0-04 §5.4/§9 标注"临时默认（Q9 未确认）"。**修订章节：§3.4、§3.5、§4.1、§4.2、§5.2、§5.4、§5.6、§6.1、§6.2、§6.3、§9、§13、§14。**
- 状态：**开发前技术基线**。字段语义以 `03-domain-model.md` 为准，接口契约以 `05-contracts/*` 为准，产品行为以 `00-product-decisions.md`（v1.1）为准，架构取舍以 `06-adr/*` 为准；本文与上述文档冲突时以更上层文档为准并回改本文。
- 关联：`06-adr/0001~0008`、`05-contracts/gateway-api.md`、`05-contracts/tauri-ipc.md`、`05-contracts/config-schema.md`、`05-contracts/error-taxonomy.md`、`08-engineering.md`、`docs/research/tech-stack.md`

---

## 0. 事实源与阅读顺序

| 问题 | 去哪个文档 |
|---|---|
| 产品要做什么、不做什么 | `00-product-decisions.md`（唯一权威）、`01-prd.md` |
| 为什么这样选 AI/壳/数据/更新 | `06-adr/*` |
| Task 有哪些字段、重复/计数/完成的具体语义 | `03-domain-model.md` |
| SQLite 表结构 | `05-contracts/storage-schema.md` |
| 客户端调 AI 的三条路径与 JSON 契约 | `05-contracts/tauri-ipc.md`、`05-contracts/ai-json.md`、本文 §5 |
| 网关对外 HTTP 接口 | `05-contracts/gateway-api.md` |
| 设置项与默认值 | `05-contracts/config-schema.md` |
| 错误码与用户文案 | `05-contracts/error-taxonomy.md` |
| 怎么建、怎么测、怎么发 | `08-engineering.md`、`07-test-strategy.md`、`11-release-ops.md` |

**关键口径澄清**："无服务器"指**用户不需要部署/运维任何服务器**；作者侧仍有一个**阿里云函数计算（FC）轻量网关**（Serverless，按量计费）作为官方 AI 服务入口，见 ADR-0001/0002。网关不是用户负担，也不是用户数据存储：它只做鉴权、限流、转发、用量记账。

---

## 1. 架构目标与约束

### 1.1 目标（可验收）

1. **零配置可用**：装好、输入激活码即可语音捕捉；无需注册账号、无需填厂商 Key。
2. **零服务器负担**：客户端不依赖任何自建后端；官方服务是不可变基础设施（FC 函数 + OSS），无 VPS、无数据库运维。
3. **数据在手**：数据只在本机 SQLite；无账号、无云同步、无遥测。
4. **快**：热键到捕捉条 < 150 ms；10 s 语音端到端 P95 ≤ 4 s（预算见 §7）。
5. **轻**：安装包 ≤ 80 MB（目标 ≤ 40 MB）；空闲常驻内存 ≤ 250 MB（详见 §7）。
6. **可降级**：官方服务不可用时 → BYOK → 规则模式；任何失败都不阻塞"把事记下来"。
7. **可换**：AI 供应商、桌面壳、解析策略均通过适配层隔离，换供应商不推倒业务代码。

### 1.2 硬约束（不可妥协）

| 约束 | 来源 | 架构含义 |
|---|---|---|
| Windows 优先，macOS 延后 | D2 | Windows 专有代码集中在 `window/`、`shortcut/`、`capture/`，其他模块跨平台 |
| 不做系统通知 | 00-decisions §7、D10/D27 | **无 notification 模块**；不申请 toast 权限；"提醒时间"字段不存在 |
| 不做首次引导 | 00-decisions §6、D26 | 启动直接进主页面；无 onboarding 路由/状态机 |
| 不做备份/导出/回收站 | 00-decisions §7、D14、ADR-0004 | 无导出代码路径；删除即物理删除；已完成 24 h 后物理删除 |
| 两状态（未完成/已完成） | ADR-0004 | 用 `completed_at IS NULL` 表达状态，无 status 枚举、无收件箱 |
| 官方网关 + BYOK + 规则三模式 | D4、ADR-0001 | `AiService` 抽象 + 能力级降级（§5.1） |
| Key 不落客户端（官方） | ADR-0006 | 官方模式客户端只持有激活码 + 设备 ID |
| 一条事件 = 标题 + 时间/重复/计数（无类型） | D21 | 显示模板是渲染层规则，不进数据层 |
| 悬浮窗透明置顶、可移动可缩放 | 00-decisions §5 | 技术风险最高，Spike S4 决定壳选型（§12） |

### 1.3 明确不做（架构层面）

- 不做本地 ASR/本地 LLM（无侧车进程、无模型下载、无 GPU 依赖）；语音必须联网。
- 不做自建账号体系、云同步、文件级备份。
- 不做后台自动 AI 调用（只在用户触发捕捉/显式操作时调用厂商）。
- 不做前端直连厂商（官方模式）或前端持有任何密钥（两种模式都不）。
- 不做托盘常驻功能（**待定**：无通知后托盘是否仍需要，见 00-decisions §10-16；架构预留可插拔空间，见 §3.3）。
- 不做全屏应用自动隐藏/点击穿透（v1 非必需；如保留为 P1，见 §12 待定项）。

---

## 2. 系统上下文

```
                    ┌────────────────────────────────────────────┐
    用户（本机）      │              Clarify 客户端                 │
  热键/语音/点击 ───► │  Tauri 主进程（Rust）+ WebView2 双窗口       │
                    │  SQLite（本机唯一数据副本）                  │
                    └───────┬───────────────────────┬────────────┘
                            │ ① 官方模式             │ ② BYOK 模式
                            │ HTTPS                 │ HTTPS / WSS（直连）
                            ▼                       ▼
              ┌──────────────────────────┐   ┌───────────────────────────┐
              │ 作者部署：阿里云 FC 网关   │   │ 用户自己的厂商账号          │
              │ /v1/health /transcribe    │   │ 百炼 ASR（转写）            │
              │ /v1/parse                 │   │ DeepSeek API（解析）        │
              │ + OSS 用量记录             │   └───────────────────────────┘
              └──────┬──────────┬────────┘
                     │          │
                     ▼          ▼
          阿里云百炼 ASR   DeepSeek API
          （转写）         （解析）

  ③ 规则模式：不发起任何 AI 网络请求，仅本地规则解析（仅文字输入）。
```

信任边界：客户端 ↔ 官方网关之间只有 Tauri IPC 暴露的本地能力；WebView2 前端不直连外网、不持有密钥。官方网关 ↔ 厂商之间密钥只在网关环境变量。BYOK 密钥只在客户端 Windows 凭据管理器（仍不经过 WebView）。

---

## 3. 进程与运行模型

### 3.1 进程清单

| 进程 | 归属 | 职责 | 备注 |
|---|---|---|---|
| `Clarify.exe` | 本产品（Tauri 主进程，Rust） | 窗口管理、热键、录音、DB、AI 调用、调度、凭据、日志 | 唯一常驻进程；单实例 |
| WebView2 主窗口渲染进程 | Windows（`msedgewebview2.exe`） | 渲染 `index.html`（主页面 + 设置页） | 由 WebView2 Runtime 管理，Tauri 不控制其生命周期 |
| WebView2 悬浮窗渲染进程 | Windows（`msedgewebview2.exe`） | 渲染 `overlay.html`（悬浮窗） | 可能与主窗口共享渲染进程，取决于 WebView2 策略；按独立页面设计 |
| 厂商服务 | 外部 SaaS | ASR / LLM | 不属本项目进程 |

**没有侧车进程、没有本地模型、没有本地推理线程池**（这是 v0.3 之后的关键简化；研究文档中关于 sherpa-onnx 的部分仅作历史证据）。

### 3.2 Windows 依赖与权限

- WebView2 Evergreen Runtime（Win11 预装；Win10 由安装器引导安装，见 §11）。
- 麦克风：WASAPI 共享模式，普通用户权限；不申请管理员权限（不做全局键盘钩子以外的特权操作，全局热键用 `RegisterHotKey` 即可）。
- 全局热键：`tauri-plugin-global-shortcut`（Windows 下 `RegisterHotKey`）。
- 无防火墙入站规则、无本地 HTTP 端口（避免"零服务器"被打折；前端资源走 Tauri 自定义协议）。
- 网络出口：HTTPS 443（官方网关/BYOK）；BYOK 实时 ASR 需要 WSS 443（待 Spike S1 验证客户端直连形态）。

### 3.3 单实例与生命周期

**启动顺序**（Rust 侧 `app::bootstrap`）：

1. `tauri-plugin-single-instance` 检测；已有实例 → 唤起它的主窗口后退出本进程（不创建第二个悬浮窗）。
2. 从 SQLite `settings` 表加载 `settings` 配置文档 → 校验/迁移（`05-contracts/config-schema.md`）。
3. 打开 SQLite → `quick_check` → 执行迁移（事务内；失败则只读安全模式，见 §6.4）。
4. 启动调度器（启动即做一次对账清理：24 h 物理删除 + 计数周期重置）。
5. 注册全局快捷键（失败 → `CLR-E6001`，不阻塞启动，设置页可改键重试）。
6. 创建悬浮窗（恢复几何/透明度/材质；材质失败自动降级，`CLR-E6003`）。
7. 首次启动（数据库无设置记录）显示主窗口主页面（**无引导**）；之后启动默认只显示悬浮窗，主窗口按需打开。

**关闭与退出**：

- 主窗口关闭按钮 = 隐藏主窗口（应用继续运行，悬浮窗存活）——v1 **暂按 `hide` 硬编码实现**；该行为待定（§10-16 托盘/后台方式，未列入 settings schema，确认后再加字段），可能调整为退出。
- 应用退出唯一入口：设置页「退出 Clarify」（v1）；退出后快捷键失效、悬浮窗消失、无后台进程。
- 崩溃/被任务管理器结束：本机数据以 SQLite 已提交事务为准；**处理中的捕捉（音频在内存、文本未落库）会丢失**，这是"音频不落盘 + 无备份"的已知代价，见 §6.3。
- **托盘**：v1 不实现。若后续确认"托盘常驻"是必需体验，在 `window/` 增加 tray 子模块（`tauri` 的 `tray-icon` feature），生命周期与主窗口解耦，不影响其他模块；需新增 ADR（00-decisions §10-16）。

### 3.4 线程与并发模型

| 执行单元 | 实现 | 约束 |
|---|---|---|
| Tauri 事件循环（主线程） | Tauri 内部 | 不做阻塞 IO；所有命令处理立即 `spawn` 到 tokio |
| tokio 运行时 | `tokio` 多线程 | AI HTTP/WS、调度、事件推送 |
| DB 写线程 | 专用线程 + `mpsc` actor（rusqlite `Connection` 单写） | 全部写操作串行化；读可用同一连接（WAL 支持并发读），查询在阻塞线程池执行 |
| 录音回调线程 | `cpal` 回调 | 只做"拷贝进环形缓冲"；禁止分配大内存/记日志；重采样与 VAD 在 tokio 侧 |
| WebView2 | OS 管理 | 前端只通过 IPC 访问能力；不持有密钥/路径/网络 |

并发规则：

- 同一 `capture_id` 的 `ai_transcribe` 只允许一次（音频句柄一次性消费；重复调用返回 `CLR-E3009`）。
- 所有写命令带客户端 `op_id`（见 `tauri-ipc.md` §重试），Rust 侧做 60 s 去重，防止前端重试导致重复完成/重复 +1。
- 事件推送由 Rust 统一 `emit`，前端不做跨窗口直接通信；两个窗口通过事件 + 重新查询保持一致（主窗与悬浮窗可能同时可见）。

### 3.5 时间与可测性（P0-03）

业务时间**只能**通过注入的 `Clock` 获取，禁止业务模块直接调用系统时间：

| 项 | 约束 |
|---|---|
| 唯一时间源 | `Clock` trait（`src-tauri/src/clock/`）；`AppState` 持有 `Arc<dyn Clock>` 并注入所有模块（db/capture/ai/scheduler/ipc…） |
| 接口 | `now_utc() -> DateTime<Utc>`；`local_date() -> NaiveDate`；`local_week_key() -> String`（ISO 周键 `YYYY-Www`）；时区取系统时区，由实现封装 |
| 生产实现 | `SystemClock`：读系统时钟；**仅此实现**允许 `SystemTime::now()` / `Utc::now()` / `Local::now()` |
| 测试实现 | `FakeClock`：可设定/推进时间（秒级），用于 24 h 边界、计数跨日/跨周、时钟回拨（domain §6.5） |
| 禁止 | 业务模块出现 `SystemTime::now()`、`Utc::now()`、`Local::now()`、直接 `chrono::Local` / `time::OffsetDateTime::now_utc`；CI 用 `rg` 守门（08-engineering §3.2/§6） |
| 写入时间 | `created_at`/`completed_at` 等由 Clock 提供（回拨规则见 domain §6.5）；发给 AI 的 `now` 也来自 Clock，不接受前端/外部输入覆盖（`ai.parse` 的 `now` 入参仅 debug 构建接受） |
| 测试触发 | 24 h 清理/周期重置的生产触发为启动、每 60 分钟、唤醒；测试走 `maintenance.run{now_override?}`（仅 debug 注册，能力白名单仅 main，见 tauri-ipc §4.18），注入 now 立即执行一轮清理/重置并断言（满足 07-test-strategy TQ-1/TQ-2，不需要真实等待） |
| 显示边界 | 业务边界判断（逾期/今天/周期键/24 h）全部在 Rust 侧用 Clock 计算；前端只渲染下发的 UTC/派生字段，不自行"现在"推算业务边界 |

> 该约束是 M1 出口 DoD 的一部分（07-test-strategy §11.3）；实现时以 `clock` 模块为唯一入口，任何例外需在 PR 说明理由并登记。

---

## 4. 模块边界

### 4.1 模块总表

| 模块 | 位置（建议） | 职责 | 明确不做 | 关键依赖 |
|---|---|---|---|---|
| `app` | `src-tauri/src/app/` | 启动/退出、单实例、模块装配、AppState、DB 路径常量（唯一） | 业务规则 | 所有模块 |
| `clock` | `src-tauri/src/clock/` | `Clock` trait + `SystemClock`/`FakeClock`；唯一时间来源（`now_utc`/`local_date`/`local_week_key`） | 不承载业务规则、不直接读配置 | 无（仅 chrono） |
| `db` | `src-tauri/src/db/` | SQLite 连接与事务、迁移（`migrations/*.sql` 薄执行器，见 storage-schema §3.3）、Event/完成日志/设置读写、视图查询 SQL | 不做 AI、不做窗口 | rusqlite、clock |
| `capture` | `src-tauri/src/capture/` | 麦克风采集、16 kHz 单声道重采样、VAD/静音断句、15 s 上限、WAV 编码（内存） | 不落盘、不转写 | cpal、rubato、hound |
| `asr` | `src-tauri/src/asr/` | `AsrProvider` trait；官方网关实现、BYOK 直连实现 | 不解析语义、不存音频 | reqwest（官方）、WS 客户端（BYOK，待 spike） |
| `ai` | `src-tauri/src/ai/` | 模式/能力决策、`ParseProvider` trait（官方/BYOK）、规则解析器、JSON Schema 校验、批量落库编排 | 不弹窗、不阻塞捕捉 UI | serde_json、jsonschema（或手写校验）、db |
| `scheduler` | `src-tauri/src/scheduler/` | 24 h 物理删除、重复任务下一跳推进、计数周期重置、WAL checkpoint、启动/唤醒对账 | 不做通知（无通知模块） | tokio、db |
| `window` | `src-tauri/src/window/` | 主窗口/悬浮窗创建、显隐、几何持久化、透明度/材质（含降级）、置顶、跳过任务栏 | 不做业务数据 | tauri、Win32（spike） |
| `shortcut` | `src-tauri/src/shortcut/` | 全局热键注册/冲突处理/改键 | 不做键盘钩子监控 | tauri-plugin-global-shortcut |
| `credentials` | `src-tauri/src/credentials/` | Windows 凭据管理器读写、内存零化、一次取用 | 不向前端返回明文 | keyring、secrecy/zeroize |
| `settings` | `src-tauri/src/settings/` | 设置加载/校验/迁移/合并/持久化；副作用应用 | 不存密钥 | serde、db |
| `ipc` | `src-tauri/src/ipc/` | 命令注册、入参校验、错误信封、能力（capability）边界、事件定义 | 不含业务逻辑（薄层） | 所有服务 |
| `logging` | `src-tauri/src/logging/` | 本地滚动日志 + 脱敏过滤 | 不上报、不记录正文/音频/Key | tracing（可选 `tracing-subscriber`） |
| `error` | `src-tauri/src/error/` | 统一错误类型、错误码映射（见 error-taxonomy） | — | thiserror |

### 4.2 依赖规则

允许的依赖方向（上层可依赖下层，禁止反向）：

```
所有模块 ──► clock（只读时间；Clock 不依赖任何业务模块）
ipc ──► app/settings/window/capture/ai/quota
ai  ──► asr?（否：ai 只依赖 db + parse provider；asr 独立）
capture ──► (无业务依赖)
asr ──► credentials + error
ai ──► credentials + db + error
scheduler ──► db + clock
window ──► settings + error
settings ──► db + error
db  ──► error + clock
```

禁止：`db` 调用 `window`/`ipc`；`capture` 直接发网络；`window` 直接查 DB；任何模块直接读 `settings` 密钥字段（密钥只在 `credentials` 与发起请求的 `asr`/`ai` 之间流动）；**任何模块直接调用系统时间 API（必须经 `Clock` 注入）**；**任何模块硬编码 DB 路径（唯一常量在 `app` 启动层，注入给 `db`；测试经 `CLARIFY_DB_PATH` 注入）**。

### 4.3 前端 ↔ 原生层边界

- 前端是**纯展示与交互层**：只通过 `tauri-ipc.md` 定义的命令/事件访问数据与能力；不直接访问文件系统、网络、凭据、注册表。
- Tauri 2 **capabilities（权限清单）按窗口 label 收敛**：
  - `main`：全部业务命令；
  - `widget`：只读视图查询、完成/计数、窗口自控（几何/样式）、打开主窗口；**不可**修改设置、不可读写凭据、不可删除任务、不可发起捕捉（悬浮窗创建入口待定，见 00-decisions §10-11，默认不做）。
- WebView2 只加载本地打包资源（Tauri 自定义协议），CSP 禁止远程脚本/远程连接/内联 eval；两条渲染进程都不含密钥与网关地址直连能力。
- 所有前端入参在 Rust 侧**再次校验**（长度、枚举、范围、几何值），不信任前端。

---

## 5. AI 三模式与数据流

### 5.1 模式定义与"能力级降级"

设置里 `ai.mode` 是**偏好**，实际执行按能力（转写 `asr` / 解析 `parse`）独立解析来源：

| 偏好模式 | 转写来源顺序 | 解析来源顺序 | 说明 |
|---|---|---|---|
| `official`（默认） | 官方 → BYOK（已配置）→ **语音不可用**（提示转文字） | 官方 → BYOK（已配置）→ 规则 | 零配置主路径 |
| `byok` | BYOK → 官方（有激活码）→ 语音不可用 | BYOK → 官方 → 规则 | 自带 Key 用户 |
| `rules` | 不发起 AI（语音输入不可用） | 规则 | 纯文字捕捉；不花钱、不联网 |

降级是**单次请求内**的，不修改用户设置（避免"我明明选了官方，怎么自己变规则了"）；结果通过 `ai_parse` 返回的 `mode_used`/`degraded` 与界面轻提示体现（文案见 error-taxonomy/ux-spec）。BYOK 解析未配置、官方未激活时，规则模式永可用。

> **待产品确认（PRD Q21/Q27）**：上表的降级顺序是本文建议实现；确认前按此实现并保持 `ai_policy` 可配置。若 Q21（BYOK 是否覆盖 ASR、切换细节）或 Q27（未激活/额度尽时语音是否可用）结论不同，需回写本表、`05-contracts/tauri-ipc.md` §1.4 与 `error-taxonomy.md`。当前架构事实：转写是云端的，**规则模式下语音不可用，只能文字**（除非 BYOK 直连转写成立）。

> 待 Spike S1 确认：BYOK 模式下"客户端直连百炼实时 ASR（WSS + 用户 Key）"的可行性与工作量。若不达预期，v1 的 BYOK 只覆盖**解析**能力，转写仍走官方网关或退化为文字输入；该变更需回写本表与 `05-contracts/*`。

### 5.2 语音捕捉主链路（官方模式，正常路径）

```
[主窗口/捕捉条 UI]                    [Rust 原生层]                                [云端]
  热键 Ctrl+Alt+Space
      │ invoke capture_start(mode=voice)
      ├──────────────────────────────► capture::start
      │                                  ├─ cpal 打开默认麦克风（WASAPI 共享）
      │ ◄── capture.level (20 Hz) ───────┤
      │                                  └─ 环形缓冲 48k float
      │ 用户停说/松开(按住说话)/VAD 静音 1.2s/15s 上限
      │ ◄── capture.auto_stop ────────────┤（VAD/上限触发）
      │ invoke capture_stop(capture_id)
      ├──────────────────────────────► capture::finalize
      │                                  ├─ 重采样 16 kHz 单声道
      │                                  ├─ 内存 WAV（≤15 s，≈480 KB）
      │ ◄── {audio_ms, too_short} ────────┘   （音频只在内存，句柄 TTL 120 s）
      │ invoke ai_transcribe(capture_id)
      ├──────────────────────────────► asr::OfficialProvider
      │                                   └─ HTTPS POST {gateway}/v1/transcribe
      │                                        (X-Activation-Code, X-Device-Id, audio/wav)
      │                                  ◄── 文本 + 用量/延迟
      │ ◄── {text, provider, latency_ms} ──┘   （音频缓冲 zeroize 丢弃）
      │ invoke ai_parse({text, source=voice, capture_id})
      ├──────────────────────────────► ai::parse
      │                                  ├─ POST {gateway}/v1/parse → deepseek-flash JSON
      │                                  ├─ Schema 校验（ai-json.md）
      │                                  ├─ 失败 → 规则解析兜底（§5.5）
      │                                  └─ db::insert_events(events, batch_id) 单事务
      │ ◄── {batch_id, events[], mode_used, degraded, timings} + 事件 event.created ×n
      ▼
  捕捉条临时草稿卡 → 替换为真实任务；视图失效重查；轻提示"已安排 · 明天 15:00"
```

要点：
- 草稿卡是**捕捉条内的临时 UI**（不入库、无收件箱实体）；解析成功后由真实任务替换。
- 音频从不写盘：不写临时文件、不进日志、不进崩溃转储；`ai_transcribe` 返回或失败后缓冲立即 zeroize。
- `capture.level` 仅用于波形动效，20 Hz，单条 < 8 B；不需要时前端可关闭（见 `tauri-ipc.md`）。
- 流式字幕（`capture.partial`）为 **P1/待 spike**：若官方 ASR 走流式，需要网关把流式结果透传为 SSE/WS；v1 默认**不做**，"停止后统一出结果"。

### 5.3 BYOK 链路

与 §5.2 相同，只是 `asr`/`ai` 的 provider 换成直连实现：

- 解析：`POST {byok.parse_base_url}/chat/completions`（OpenAI 兼容），`Authorization: Bearer <用户 Key>`，`response_format: json_object`，模型默认 `deepseek-flash`。
- 转写：百炼 DashScope（形态待 Spike S1；实时 WSS 或等价接口），Key 从 Credential Manager 取，仅本次请求持有。
- BYOK 请求不经过作者网关；客户端不记录请求/响应正文；超时/重试策略见 `tauri-ipc.md`。
- 费用由用户自己承担；客户端可显示"本月本地估算用量"（可选 P1，非计费依据）。

### 5.4 规则模式与文字链路

- 文字捕捉 = 同一捕捉条直接打字（无麦克风）；`ai_parse` 入参 `source=text`，`capture_id` 可空。
- `ai.mode=rules` 或降级到规则时：`ai::rules` 用本地词典/正则做时间表达（明早、下周三、三点半）、简单重复（每天/每周一）、分句拆条（和/还有/逗号），**只解析明确内容**；无法确定就留空（不猜、不补默认，见 00-decisions §3）。
- 规则解析产出的条数上限与拆分策略与 LLM 一致（单次 ≤5 条），超限截断并提示。
- 规则解析失败（极少）→ 整段原文作为一条标题、无时间/重复/计数；**保留原文标题**——这是 **临时默认（Q9 未确认）**，不是最终决定；用户确认后回写此处、`ai-json.md` §7.3、`error-taxonomy.md` E4005 与 PRD/UX 文案。

### 5.5 解析输出校验与兜底顺序

1. 官方/BYOK 返回 JSON（DeepSeek JSON Output，系统提示词固定）。
2. **网关侧**：校验可解析、顶层结构、条数 ≤5、字段类型；不合格先重试 1 次；仍不合格 → 502 `UPSTREAM_INVALID_JSON`。
3. **客户端侧**：用 `05-contracts/ai-json.md` 的 JSON Schema 再校验一次（纵深防御）；不合格 → 规则兜底。
4. 超时阈值：转写客户端单次 8 s；解析客户端 12 s（覆盖网关"单次 5 s + 校验失败重试 1 次、总预算 ≤11 s"，ai-json §1/§7）；网关上游：转写 5 s、解析单次 5 s。超时 → 按"可重试一次（网络/5xx/504）→ 规则兜底"。
5. 任何情况下：**用户输入不丢**——文字输入在 UI 内保留可编辑；语音输入在 ASR 失败且无部分文本时提示重说（音频不落盘，无法"稍后重试"）。

### 5.6 官方网关内部（简述，契约见 gateway-api.md）

```
阿里云 FC 函数（Node 20，HTTP 触发器，默认域名）
  index.handler
   ├─ 路由：GET /v1/health | POST /v1/transcribe | POST /v1/parse
   ├─ 鉴权：X-Activation-Code（HMAC 比对哈希白名单，常量时间）+ X-Device-Id 规范化
   ├─ 配额：每设备每日 **200 单位**（1 单位 = 1 次捕捉，转写+解析合并计 1；北京时间 00:00 重置）；月预算 ¥200（80% 告警/100% 停止）
   ├─ 转发：ASR provider 适配层（默认候选百炼实时 WS）；DeepSeek /chat/completions
   ├─ 校验：解析 JSON 结构；失败重试 1 次
   ├─ 用量：写 OSS 记录（只含状态/延迟/用量/哈希，不含音频与正文）
   └─ 日志：不打印 body；只记录 request_id/状态/延迟/用量
```
网关无状态、无数据库、无音频存储；用量记录在 OSS（生命周期规则自动过期）。配额/预算的原子性与精度风险见 gateway-api.md §6 与 Spike S2。

> **额度重置权威（P1-05）**：重置时间由**网关**按北京时间 00:00 判定，客户端只展示网关返回的 `X-Quota-Reset-At` / `ServiceStatus.quota.reset_at`，**不得按本地时区自行推算或倒计时到本地零点**（防改时区刷额度）。

---

## 6. 数据与生命周期（无通知 / 无备份策略）

### 6.1 存储

- 唯一数据副本：**`%LOCALAPPDATA%\app.clarify.desktop\clarify.db`**（SQLite，WAL）。**本文是 DB 路径/文件名的唯一事实源**：`bundleIdentifier` 固定为 `app.clarify.desktop`；`05-contracts/storage-schema.md`、`11-release-ops.md`、`05-contracts/config-schema.md` 只引用本行、不另定义。测试/开发注入见 `config-schema.md` §10.4（`CLARIFY_ENV`/`CLARIFY_DB_PATH`，生产忽略）。
- 表：`events`、`event_completions`、`settings`、`schema_migrations`（唯一事实源：`05-contracts/storage-schema.md`）。
- 连接参数：`journal_mode=WAL`、`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=5000`；单写线程（§3.4）。
- 日志文件（可选）：同目录 `logs/app.log`，滚动 ≤1 MB × 2，默认 `warn`，不含用户内容（§8.3）。
- **不产生**：备份文件、导出文件、音频文件、临时音频、模型文件、缓存目录。

### 6.2 生命周期与物理删除

| 对象 | 规则 | 执行者 |
|---|---|---|
| 未完成事件 | 一直存在，直到完成或被用户永久删除 | — |
| 单次/无时间事件完成 | 所有视图底部折叠可见；`completed_at` 起 24 h 内可恢复；**24 h 后物理删除** | scheduler |
| 重复任务完成（本次） | 写 `event_completions` 完成日志；系列保留并推进下一次；本次完成日志 24 h 后物理删除 | scheduler |
| 计数任务 | `count_progress` + `count_period_key`；**无完成日志、永不写 `completed_at`、无 24 h 删除**；仅周期边界（每天 00:00 / 每周一 00:00）清零，完成态由 `count_progress >= count_target` 派生（domain §8、storage-schema §9.3） | scheduler（懒重置 + 清理兜底） |
| 用户删除 | 详情抽屉内删除 = 立即物理删除，**不可恢复**（无回收站） | ipc/db |
| 捕捉中数据 | 只在内存（音频）或只在 UI（打字）；**不落盘**，崩溃即丢 | — |
| 设置 | 持久化于 SQLite `settings` 表 key=`settings` 的文档（**无密钥**；见 config-schema） | settings |

调度器语义（`scheduler`）：

- 触发：应用启动、每 **60 分钟**、系统唤醒后（定时器漂移 → 用**对账式扫描**而非精确延时；同一时刻单飞）。
- 可见性：已完成项从**视图查询**层按 `completed_at + 24h` 过滤（到点即不再显示）；**物理删除**由清理作业在下一个 60 分钟窗口内完成（即 24h 后 ≤1h 内删除，storage-schema §9）。
- 删除条件：**仅**删除两类数据——(a) 单次/无时间型已完成事件行（`completed_at <= now - 24h` 且 `repeat_freq IS NULL`、`count_target IS NULL`）；(b) 周期任务的 `event_completions` 行（`completed_at <= now - 24h`）。周期任务系列行永不因完成而删除；**计数任务不删除，只按周期键重置**。
- 计数器重置：按 Clock 的 `local_week_key()`/`local_date()` 计算当前周期键，与存量不同则 `count_progress=0`、`count_period_key=当前键`；计数任务**永不写 `completed_at`**（domain §8）。
- 删除后不额外 `VACUUM`；WAL autocheckpoint 由 SQLite 负责（storage-schema §2）。
- 失败重试：下一次 tick 自动重试；**绝不删除未完成项**。
- 精度：以"启动/唤醒对账"保证最终一致；已完成折叠的倒计时文案按 domain §4 展示（UI 文案由 02-ux-spec 定义）。

### 6.3 无备份 / 无导出的工程含义与补偿控制

用户明确不做备份、导出、回收站（00-decisions §7、D14；ADR-0004）。工程上必须诚实面对后果：

| 风险 | 不可用手段（产品已否决） | 保留的补偿控制 |
|---|---|---|
| 误删 | 回收站/撤销 | 删除入口收在详情抽屉、二次确认文案（UX 决定）；删除后不可恢复必须明示 |
| 误完成 | 软归档/30 天恢复 | 24 h 内可恢复（`event.restore`）；完成后 1 s 内从悬浮窗消失、主窗底部折叠 |
| 换机/重装 | 导出/导入/云同步 | 明确告知"数据只在本机，不提供备份"（位置待定，00-decisions §10-17） |
| 库损坏 | 备份文件 | 只读模式启动或提示"数据损坏，无法打开"（storage-schema §15）；不自动修复/重建、不生成数据库副本（storage-schema §11） |
| 崩溃丢输入 | 音频落盘 | 录音 ≤15 s 且音频绝不落盘；已入库数据不丢（WAL 原子性）；处理中丢失必须在文档与 UI 文案中明示 |
| 迁移失败 | 回滚备份 | 迁移在单事务内执行：失败自动回滚，旧库保持可用；禁止破坏性迁移 |

**明确不提供**：任何 `export`/`backup`/`import`/`recycle` 命令或隐藏入口（含调试用；测试用夹具走独立脚本 + 测试库）。

### 6.4 迁移与损坏处理

- 迁移：`src-tauri/migrations/NNNN_name.sql` 版本化 SQL（唯一规范见 storage-schema §3.3，文件内自带 `BEGIN IMMEDIATE … COMMIT`）；薄执行器按 `PRAGMA user_version` 顺序 `execute_batch`，一个文件只升一个版本；失败 → 事务回滚 → **拒绝启动/只读报错**，不自动重建、不生成副本。
- 前向兼容：`user_version > 应用支持上限`（降级安装）→ **拒绝启动**并提示升级应用，不做任何写入（storage-schema §3.2）。
- 损坏：`quick_check`/`foreign_key_check` 失败 → 记录错误（无内容）→ 只读模式启动或提示无法打开；**不做自动修复/重建、不生成数据库副本**（storage-schema §11/§15）。

---

## 7. 性能预算

口径：Windows 11 22H2、中端笔记本（8 核 / 16 GB / 集显或入门独显）、家用宽带（RTT ≤60 ms）；每项取 P95，测量方式为 Rust 侧 `tracing` 时间戳 + Spike 脚本记录到 `docs/research/spike-results.md`。

| 指标 | 目标 | 验收上限 | 测量点 | 备注 |
|---|---|---|---|---|
| 热键 → 捕捉条可见 | ≤120 ms | **150 ms** | shortcut 回调 → 前端首帧 | 硬指标（charter §5） |
| 停止录音 → 草稿卡上屏 | ≤200 ms | 300 ms | capture_stop 返回 → UI 渲染 | 纯本地，不依赖网络 |
| 10 s 语音转写（ASR） | ≤1.2 s | 1.5 s | 网关响应耗时（含网络） | Spike S1 决定供应商 |
| 解析（DeepSeek） | ≤2.0 s | 2.5 s | 网关 parse 响应 | 非思考模式 + JSON Output |
| **端到端（停止 → 结果上屏）** | ≤3.5 s | **4 s** | 停止 → `event.created` 渲染 | charter §5；P95 |
| 冷启动 → 悬浮窗可见 | ≤2.0 s | 2.5 s | 进程启动 → widget 首帧 | 不含首次安装 WebView2 |
| 空闲常驻内存（合计） | ≤200 MB | 250 MB | 任务管理器/Get-Process 求和 | 主进程 + WebView2 进程组 |
| 峰值内存（录音+解析） | ≤350 MB | 500 MB | 同上 | 无本地模型 |
| 空闲 CPU（30 min 均值） | ≤0.5% | 1% | 任务管理器 | 无通知/无轮询网络 |
| 安装包（NSIS，不含用户数据） | ≤40 MB | 80 MB | `tauri build` 产物 | WebView2 用 bootstrapper |
| 本地视图查询 | ≤30 ms | 50 ms | view_query 服务端耗时 | 单库 ≤数万行（实际更小） |
| 悬浮窗点击完成 → 消失 | ≤300 ms | 1 s | 点击 → 动画完成 | charter §3.2（1 s 内） |
| 数据库体积 | 典型 ≤20 MB | 100 MB（10 万条级参考，storage-schema §12） | 文件大小 | 24 h 清理限制完成日志增长；无备份/导出 |

预算分配原则：端到端 4 s 中，网络 + ASR ≤1.5 s、解析 ≤2.2 s、本地 UI ≤0.3 s；任一环节超预算先降级（规则/重试一次）再谈优化。

---

## 8. 安全与隐私

### 8.1 威胁模型与缓解

| 威胁 | 场景 | 缓解 |
|---|---|---|
| 官方厂商 Key 泄露 | 客户端被逆向/抓包 | Key 只在 FC 环境变量；客户端无 Key；网关不打印请求头；ADR-0006 |
| 激活码被分享/盗刷 | 内测码外流 | 每设备每日 200 次；月预算硬上限；激活码可吊销；设备 ID 哈希记录；异常告警（gateway-api §6） |
| BYOK Key 泄露 | 配置文件/日志/崩溃转储 | 只存 Windows Credential Manager（DPAPI）；内存 `SecretString` 用完零化；不写日志、不进设置 JSON、不传前端（仅掩码） |
| 音频泄露 | 落盘/日志/临时文件 | 音频只在内存；不写临时文件；不记日志；崩溃转储不含音频（无音频对象可转储） |
| 正文泄露 | 网关日志/OSS | 网关不记录 body；OSS 只记计量与哈希；客户端本地日志不含标题正文 |
| 中间人 | 公共 Wi-Fi | 全链路 HTTPS/WSS（TLS 1.2+）；不关闭证书校验；不自建 CA/不做证书固定（避免更新失效，v1 内测可接受） |
| 本地数据被同机程序读取 | 多用户 PC | 数据在用户目录 `%LOCALAPPDATA%`（默认 ACL 仅当前用户）；不额外加密数据库（SQLite 无加密扩展；风险登记：同机恶意程序，见 10-risks R 系列） |
| 前端被注入脚本 | 远程内容/依赖供应链 | CSP 禁远程；依赖锁定 + `cargo-deny`/`pnpm audit`；无远程 HTML |
| 隐私告知缺失 | 无首启引导 | 必在设置/界面某处明示"音频发 ASR 厂商、文字发 DeepSeek"，位置待定（00-decisions §10-17）；文案由 UX 定 |

### 8.2 密钥流（两模式）

```
官方模式：
  激活码（用户输入，经 IPC 一次性写入） → Windows Credential Manager target=Clarify/official/activation-code
  每次请求：credentials::get → 放入 HTTPS Header → 内存零化（不缓存明文）
  厂商 Key：只在 FC 环境变量（作者）；客户端不可见
  设备 ID：设置 JSON 内随机 UUID（非密钥，用于配额）

BYOK 模式：
  用户 Key → Credential Manager（target=Clarify/byok/{deepseek,aliyun}）
  请求时读取 → SecretString → Authorization Header → 零化
  设置页只显示 configured + 掩码（如 sk-****3f2a），永不回传明文
```

凭据管理器目标名、读写时机、删除/切换流程见 `05-contracts/config-schema.md` §9。

### 8.3 日志与遥测红线

- **无遥测、无崩溃上报、无使用统计、无 A/B**：代码中不得引入任何统计 SDK；网络请求白名单 = 配置的 AI 端点（+ 可选的更新检查，P1）。
- 本地日志默认 `warn`；只允许记录：时间、模块、事件名、耗时、错误码、任务 ID（UUID，非内容）、设备 ID 哈希前缀。
- 禁止记录：音频字节、原始/转写文本、任务标题、激活码、任何 Key、完整响应体（解析 JSON 亦不整体落日志）。
- 日志脱敏过滤器在 `logging` 模块集中实现；新增日志点需过 PR checklist（08-engineering §PR checklist）。

---

## 9. 失败降级矩阵

| # | 失败点 | 检测 | 用户可见 | 系统动作 | 数据影响 | 可重试 |
|---|---|---|---|---|---|---|
| 1 | 麦克风不可用/被占用 | `cpal` 打开失败 | "麦克风不可用，可直接打字" | 捕捉条切文字模式 | 无（未录） | 用户可再试 |
| 2 | 录音过短/无声 | 时长 <300 ms 或能量过低 | "没听清，再说一次或打字" | 不发送、不落库、释放缓冲 | 无 | 是 |
| 3 | 断网（ASR 云端） | 请求前探测/请求失败 | "离线时语音不可用，可打字；或稍后重试" | 语音禁用/失败转文字；解析走规则 | 已输入文字可保留 | 联网后重试（需重说） |
| 4 | ASR 上游失败（502/504） | 网关状态码 | "转写服务暂时不可用，已切到文字" | 重试 1 次 → 失败转文字编辑；音频丢弃 | 音频无法恢复（不落盘） | 重试 1 次 |
| 5 | ASR 成功但文本为空 | 返回空字符串 | "没听清，再说一次" | 不解析、不落库 | 无 | 是 |
| 6 | 官方激活码无效/被吊销（401） | 网关 401 | "激活码无效/已停用，请到设置更新（或改用自带 Key）" | 停止官方调用；BYOK 已配置则本次自动用 BYOK；否则解析走规则 | 无 | 用户修正配置 |
| 7 | 每日额度用尽（429） | 网关 429 + 配额头 | "今日 AI 额度已用完，明天 00:00 恢复；当前用规则模式" | 当日不再调用官方；BYOK 优先，解析规则兜底 | 任务照常创建 | 次日 |
| 8 | 月预算用尽（429） | 网关 429 + `X-Budget-State: exhausted` | "官方 AI 服务本月预算已用尽，服务暂停" | 官方全停；BYOK/规则继续 | 任务照常创建（规则） | 下月/作者调预算 |
| 9 | 解析 JSON 非法/超时 | 校验失败/504 | 无感（轻提示"已用本地规则安排"） | 客户端规则兜底；记录错误码 | 任务照常创建 | 自动 1 次 |
| 10 | 规则解析也无法动作化 | 规则返回 0 条 | 无感 | 用原文整段建 1 条、无时间（**临时默认（Q9 未确认）**，见 ai-json §7.3） | 任务照常创建 | — |
| 11 | 写库失败（磁盘满/损坏） | `rusqlite` 错误 | "保存失败，请重试；输入已保留" | 保留 UI 文本可重试；报 `CLR-E5002`；损坏 → 只读模式 | 未保存，UI 保留 | 用户重试 |
| 12 | 热键注册冲突 | 注册返回失败 | 设置页提示改键（`CLR-E6001`） | 继续启动；悬浮窗与主窗仍可用 | 无 | 用户改键 |
| 13 | 透明/毛玻璃不可用 | 窗口效果设置失败 | 无感（首次提示"已切换性能/兼容模式"） | 降级为不透明/低透明纯色 | 无 | 启动时重试 |
| 14 | 悬浮窗创建失败 | 窗口创建错误 | 主窗提示 `CLR-E6002`，功能降级为主窗可用 | 仅主窗运行 | 无 | 重启 |
| 15 | 24 h 清理失败 | 调度任务错误日志 | 无（下次 tick 重试） | 重试；不删未完成 | 已完成项延迟消失 | 自动 |
| 16 | 凭据管理器不可用 | keyring 错误 | "无法安全保存激活码（`CLR-E1007`）" | 不降级为明文存储；提示系统问题 | 无法进入官方/BYOK | 用户重试 |
| 17 | 系统休眠/唤醒 | 定时器补偿 | 无 | 启动/唤醒对账：清理 + 计数重置 | 无 | 自动 |
| 18 | 应用崩溃/被杀 | 重启检测 | 无（上次捕捉未完成会丢） | WAL 恢复已提交事务 | 处理中捕捉丢失（§6.3 明示） | — |

---

## 10. 依赖与许可证摘要

版本以 `Cargo.lock`/`pnpm-lock.yaml` 锁定；完整第三方清单与合规文本由 `11-release-ops.md` 维护。许可证策略：允许 MIT/Apache-2.0/BSD/ISC/MPL-2.0；**GPL/AGPL/SSPL 及来源不明一律禁止**（CI `cargo-deny` + `license-checker` 拦截）。

| 依赖 | 建议版本 | 用途 | 许可证 | 备注 |
|---|---|---|---|---|
| Tauri | 2.12.x | 桌面壳/窗口/IPC/打包 | MIT 或 Apache-2.0（双许可） | 固定次版本，升级需回归 |
| tauri-plugin-global-shortcut | 2.4.x | 全局热键 | MIT/Apache-2.0 | |
| tauri-plugin-single-instance | 2.5.x | 单实例 | MIT/Apache-2.0 | |
| tauri-plugin-autostart | 2.7.x | 开机自启 | MIT/Apache-2.0 | **P1/待确认**（v1.1 未列入） |
| tauri-plugin-updater | 2.14.x | 自动更新 | MIT/Apache-2.0 | M5 前接入（ADR-0007） |
| rusqlite（bundled） | 0.41.x | SQLite 访问 | MIT；SQLite 本体 Public Domain | `bundled` 无系统依赖 |
| 迁移执行器 | 自研薄 runner（无第三方库） | 顺序执行 `migrations/*.sql`（文件内含事务，storage-schema §3.3） | — | 避免 ORM/迁移库与"文件内事务"双重包裹 |
| tokio | 1.x | 异步运行时 | MIT | |
| reqwest | 0.13.x | HTTP 客户端 | MIT/Apache-2.0 | 官方/BYOK 请求 |
| tokio-tungstenite | 0.2x | WSS 客户端 | MIT/Apache-2.0 | BYOK 直连 ASR 时才需要（待 S1） |
| cpal | 0.18.x | WASAPI 录音 | MIT/Apache-2.0 | |
| rubato | 5.0.x | 重采样 | MIT | |
| hound | 3.x | WAV 编码 | MIT/Apache-2.0 | 仅内存 |
| keyring | 3.x | Windows 凭据管理器 | MIT/Apache-2.0 | DPAPI |
| secrecy / zeroize | 0.10/1.x | 密钥零化 | MIT/Apache-2.0 | |
| serde / serde_json | 1.x | 序列化 | MIT/Apache-2.0 | |
| jsonschema（或手写校验） | 0.2x | AI JSON 校验 | MIT | 体积大则手写，见 08-engineering |
| chrono / time | 0.4.x | 时区/相对日 | MIT/Apache-2.0 | 本地时区规则 |
| uuid | 1.x | ID | MIT/Apache-2.0 | |
| thiserror / tracing | 1.x/0.1x | 错误/日志 | MIT/Apache-2.0 | |
| React | 19.3.x | 前端 | MIT | |
| TypeScript | 7.0.x | 类型 | Apache-2.0 | |
| Vite | 8.3.x | 构建 | MIT | |
| Tailwind CSS | 4.3.x | 样式 | MIT | |
| shadcn/ui | 生成代码 | 组件 | MIT | 非运行时依赖 |
| zustand | 5.x | 前端状态 | MIT | |
| Node.js | 20（FC 运行时）/ 24（开发） | 网关运行/工具链 | MIT | 网关部署运行时固定 Node 20 |
| 阿里云 FC / OSS / 百炼；DeepSeek API | 商业服务 | AI 与用量记录 | 厂商条款 | 非开源；需评估价格/条款变更（R11） |
| WebView2 Runtime | 微软 | 渲染 | 微软运行时许可（免费分发） | 系统级依赖 |

---

## 11. 运行环境要求

### 11.1 最终用户（Windows）

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10 21H2（19044）+ / Windows 11（x64）；ARM64 v1 不支持 |
| 运行时 | WebView2 Evergreen Runtime（Win11 预装；Win10 由 NSIS 安装包内置 bootstrapper 联网安装，失败则提示手动安装） |
| 内存 | 建议 8 GB+；最低 4 GB（性能不保证） |
| 磁盘 | 安装 ≤200 MB；数据典型 <20 MB（万条级 5–10 MB，storage-schema §12；无本地模型） |
| CPU | 双核 2 GHz+（录音重采样/VAD 很轻） |
| 网络 | 使用 AI 需联网；断网时仅文字 + 规则模式 |
| 音频 | 系统默认输入设备，Windows 隐私设置允许桌面应用访问麦克风 |
| 显示 | 100%–200% DPI 缩放；多显示器（悬浮窗需记住显示器 + 位置） |
| 权限 | 普通用户；无需管理员 |

### 11.2 开发环境（详见 `08-engineering.md`）

Windows 11 22H2+、Node 24 + pnpm 10、Rust stable（MSVC toolchain）、VS 2022 Build Tools（C++ 桌面开发）、WebView2 Runtime、Git；另备一台 Win10 22H2 虚拟机做兼容冒烟。

---

## 12. 悬浮窗技术风险与 Spike 项（S4）

悬浮窗是**本产品技术风险最高的部分**（10-risks R1；ADR-0003）。产品要求：独立透明置顶小组件、可移动、可缩放、足够精致、不提供设置入口（只放"进入软件首页"图标）、点任务 = 完成、模板 A 只有一天、模板 B 有今天/全部小切换。

### 12.1 风险点与验证方法

| # | 风险 | 验证方法（Win11 22H2 实机 + Win10 VM） | 通过阈值 | 失败时的架构决策 |
|---|---|---|---|---|
| S4-1 | 透明窗口黑边/白底/闪烁（WebView2 透明渲染） | `decorations:false, transparent:true, shadow:false`，不同壁纸/深浅色/Acrylic 组合，NVIDIA + Intel 集显各一轮 | 无黑边/白底；静止与滚动无可见闪烁 | 改"半透明纯色无模糊"；仍失败 → 评估 Electron 45（窗口层重写，前端/数据层复用） |
| S4-2 | 毛玻璃（Mica/Acrylic）可用性 | `WindowEffects`（Mica 仅 Win11；Acrylic Win10 1903+），对照 Win10/Win11/不同显卡 | 可用则用；不可用自动降级 | 降级 `solid/low-opacity`，设置里显示"兼容模式"；**CSS `backdrop-filter` 不能模糊桌面，不能作为方案** |
| S4-3 | 置顶 + 不抢焦点 | `always_on_top`；Win32 `WS_EX_NOACTIVATE` 实现"显示/隐藏不激活前台应用"；热键显示悬浮窗时前台窗口焦点不变 | 显示/隐藏不夺焦；点击任务可完成 | v1 允许"仅显示不夺焦、点击会聚焦"（可接受）；完全不可用 → 记 P1，不阻塞 |
| S4-4 | 无边框窗口拖拽 | 前端 `data-tauri-drag-region`；拖拽后监听 Moved 事件持久化坐标（500 ms 防抖） | 平滑、无跳动；位置刷新后恢复 | 退化：固定位置 + 设置页选角落 |
| S4-5 | 可缩放（无边框） | 自定义边缘热区调用 `start_resize_dragging`（Tauri 2 Windows 支持），最小 260×140 / 最大 480×720（待视觉细化 §10-2/§10-3） | 拖角可缩放、布局不破、宽高比自由 | 退化：预设 3 档尺寸（小/中/大）+ 设置切换 |
| S4-6 | 多显示器 / DPI 150–200% | 多屏（不同 DPI）移动窗口、拔插显示器、重启 | 位置在正确显示器恢复；文字清晰不模糊 | 仅保证主屏 + 回退主屏右上角 |
| S4-7 | 跳过任务栏 / Alt+Tab | `skip_taskbar:true`；任务栏与 Alt+Tab 均不出现 | 不出现；仍可通过热键恢复 | 可接受出现在 Alt+Tab（若不出现太复杂） |
| S4-8 | 透明 + 尺寸变化性能 | 拖拽/缩放时 GPU/CPU 占用、掉帧 | 拖拽期间无明显掉帧（主观 + PresentMon 可选） | 缩放时临时切不透明，结束后恢复 |
| S4-9 | 全屏应用/游戏时是否隐藏 | 前台全屏窗口检测（`SHQueryUserNotificationState` 等，Win32） | 可检测则做抑制（P1）；不可检测则不做 | **v1 不做**（产品决策未要求；避免误伤） |
| S4-10 | 点击穿透 | `set_ignore_cursor_events`，与"拖拽/点击完成"互斥的交互方案 | 若做锁定模式则可用 | **v1 不做**（00-decisions 未要求；P1 待定） |

### 12.2 Spike 编号与依赖

- **S1**：ASR 供应商对比与接入形态（百炼实时 vs 腾讯一句话 vs 讯飞；同步 HTTP 优先规则，见 ADR-0002）。
- **S2**：官方网关冷启动/超时/配额与用量记账（FC + OSS）可行性。
- **S3**：DeepSeek `deepseek-flash` 非思考 + JSON Output 的合法率/准确率/延迟（用 `docs/eval/` 评估集）。
- **S4**：悬浮窗组合行为（本表）。
- **S5**（建议编号）：录音链路端到端（热键→首帧、VAD 断句、WAV 大小）。
- **S6**（建议编号）：Windows 凭据管理器读写与打包后可用性（keyring/DPAPI）。
- 编号冲突以 `09-roadmap-wbs.md` 为准：窗口尖峰在 09 中编号 **SPK-WIN**（`M1-01`），与 ADR-0003 的 **S4**、`10-risks-decisions.md` R1 同义；ASR 尖峰为 **S1**（ADR-0002）。结果统一写 `docs/research/spike-results.md`，Go/No-Go 记入 `10-risks-decisions.md` §2。
- **本文件所有"待 spike"标记均视为阻塞项**：S1/S4 未通过前不冻结窗口层与 ASR 适配层的最终接口细节。

---

## 13. 待定项与 ADR 待办

已在产品决策 §10 中的，不重复展开；以下是**架构层**需要跟进的问题：

| # | 待定 | 影响 | 建议 |
|---|---|---|---|
| A1 | 托盘/后台驻留方式（00-decisions §10-16） | 主窗关闭行为、退出入口、开机自启 | 若无托盘：关闭主窗=隐藏、设置页退出；需用户确认 |
| A2 | 隐私告知位置（§10-17） | 设置页/关于页文案与布局 | 建议设置页"关于/隐私"常驻区块 + 首次捕捉后提示一次（待定，不阻塞编码） |
| A3 | 原始转写文本是否保留（§10-5） | 是否新增 `raw_text` 字段与"重新解析"入口 | v1 默认不保留（录音不落盘、原文只在当次 UI）；解析失败用原文标题兜底 |
| A4 | AI 解析无法动作化时的兜底（00-decisions §10-4 / PRD Q9） | 规则/兜底行为与用户文案 | **临时默认（Q9 未确认）**：原文整段作标题、时间空、建 1 条；确认后回写本文 §5.4/§9、ai-json §7.3、error-taxonomy E4005、01/02/07 |
| A5 | 悬浮窗视觉规格/穿透/全屏抑制（§10-2/3） | S4 验收细节 | Spike 后与视觉初稿一起定 |
| A6 | BYOK 是否覆盖转写（本文 §5.3） | 是否需要客户端 WS 客户端 | S1 后决定；默认 v1 BYOK 仅解析 |
| A7 | 网关配额/预算计数的原子性精度 | 是否引入 OTS/Tair | S2 后决定；v1 接受"≤数条超发 + 100% 停止" |
| A8 | 开机自启/自动更新是否进 v1 | 依赖插件与发布流程 | 按 09-roadmap 与 11-release-ops；v1.1 产品决策未提，默认 P1 |
| A9 | 应用 identifier/安装目录/卸载是否保留数据 | 路径与发布 | 建议 `app.clarify.desktop`、卸载不删除用户数据；11-release-ops 定 |
| A10 | 官方/BYOK/规则降级顺序、额度尽/未激活时语音是否可用（PRD Q21/Q27） | §5.1 能力级降级表、`mode_used` 语义 | 本文建议顺序（官方→BYOK→规则；规则模式语音不可用）；确认前按此实现，确认后回写本文与契约 |
| A11 | 悬浮窗透明度/快捷键是否开放自定义（02-ux Q11/Q12） | settings 字段是否在 UI 暴露 | config-schema 已预留字段；若固定则只读展示，不升 schema 版本 |

---

## 14. 变更记录

| 版本 | 日期 | 变更 | 作者 |
|---|---|---|---|
| v0.1 | 2026-11-01 | 首版：Tauri 2 双窗口进程模型、模块边界、AI 三模式与能力级降级、无通知/无备份数据策略、性能预算、安全隐私、降级矩阵、依赖许可、环境、S4 风险与 spike | tech-writer |
| v0.2 | 2026-11-01 | 红队修复：新增 §3.5 Clock/可测性约束（§4.1/§4.2 同步）；§6.1 DB 路径定稿唯一事实源并补测试注入；§6.2 计数生命周期修正（无日志/无 completed_at/无 24h 删除）；§5.6 额度重置权威 + 200 单位口径；§5.4/§9/§13 标注 Q9 临时默认；§6.3 命令名修正；§3.4 录音 15s 口径 | tech-writer |
