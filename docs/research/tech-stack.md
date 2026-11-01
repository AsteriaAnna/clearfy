# Clarify 本地技术栈研究报告

> 检索时间：2026-11-01。版本号均为当日 crates.io / npm / Hugging Face / GitHub 实时查询结果。
> 标注约定：**官方数据** = 官方文档或仓库明确声明；**实测估计** = 工程估算，须按 §8 spike 复核；**待验证** = 缺少可靠公开证据。

## 1. 结论速览

| 层次 | 推荐 | 关键理由 | 备选 |
|---|---|---|---|
| 桌面壳 | **Tauri 2.12.5**（Rust + WebView2） | 安装包小、内存低、官方插件覆盖热键/托盘/自启动/单实例/更新/SQL；Rust 侧直接跑 ASR/LLM | Electron 45.2.1（透明+穿透生态最成熟，若 Tauri 置顶穿透 spike 失败） |
| ASR 引擎 | **sherpa-onnx 2.0.1**（C API + Rust FFI） | 官方提供 off-line/streaming C API、内置 Silero VAD、CPU int8 实时性好、无 Python 依赖 | whisper.cpp（whisper-rs 0.16.0）、faster-whisper 1.2.1（Python 侧车，仅作离线评测） |
| ASR 默认模型 | **SenseVoice-Small int8，228MB**（中英日韩粤 + 中英混说） | 中文/粤语官方对比优于 Whisper；非自回归，延迟低 | 中文专用 Paraformer-zh int8 232MB；低配 Paraformer-zh-small int8 78MB |
| LLM 引擎 | **llama.cpp b12024 + llama-cpp-2 0.1.160**，或 llama-server 侧车 | GBNF/JSON Schema 约束解码，Rust 有 Grammar sampler；MIT | Ollama（MIT，开发期方便，不适合作为安装包依赖） |
| LLM 默认模型 | **Qwen3.5-4B Q4_K_M（2614MB）**，有独显时用 CUDA | Apache-2.0、2026-03 发布的小尺寸新模型；中文指令遵循好 | Qwen3.5-2B / 0.8B（无 GPU/低内存）；Qwen3-4B-Instruct-2507（Apache-2.0，备选） |
| 无 GPU 回退 | Qwen3.5-2B 或 0.8B Q4 + **规则解析兜底** | 16 核 CPU 上 4B 输出 JSON 可能超 3s 预算（实测估计） | 纯规则/正则（时间、重复、分句），LLM 超时即降级 |
| 数据层 | **rusqlite 0.41.1（bundled）+ refinery 0.10 迁移**，WAL | 单文件、无外部依赖、备份/导出简单；业务逻辑在 Rust 侧 | tauri-plugin-sql 2.6.0（sqlx，仅当前端需要直接查库时） |
| 前端 | **React 19.3.1 + TS 7.0.2 + Vite 8.3.5 + Tailwind 4.3.3 + shadcn/ui** | 生态成熟、双窗口多入口简单；zustand 5.0.16、i18next 26.6.0 | Svelte 5（更轻，但团队/生态成本高） |
| 音频/VAD | **cpal 0.18.2（WASAPI 共享模式）+ rubato 5.0.1 重采样 + sherpa-onnx Silero VAD** | 纯 Rust、无 ffmpeg；Silero VAD 为 MIT | wasapi-rs（更底层，维护弱） |
| 分发 | NSIS 安装包 + 内置 WebView2 引导（+1.8MB）+ 首次运行下载模型 | 无服务器、无账号；自动更新用 GitHub Releases 静态 `latest.json` | 离线完整包（含模型，约 +3GB） |

## 2. 桌面壳选型：Tauri 2 vs Electron（vs WinUI/WebView2 混合）

**推荐 Tauri 2.12.5**（[crates.io](https://crates.io/crates/tauri) 2026-10-21，Tauri 3 尚处 `3.0.0-alpha.5` 预发布，不建议跟）。Electron 当前 npm 最新 45.2.1（[npm](https://www.npmjs.com/package/electron)）。逐项对比：

| 能力 | Tauri 2.12.5 | Electron 45.2.1 | 结论 |
|---|---|---|---|
| 全局快捷键 | 官方 `tauri-plugin-global-shortcut` 2.4.1（[文档](https://v2.tauri.app/plugin/global-shortcut/)） | `globalShortcut` 内建 | 平手；均需处理热键冲突 |
| 托盘 | 核心 `tray-icon` feature（[文档](https://v2.tauri.app/learn/system-tray/)） | `Tray` 内建 | Tauri 够用 |
| 系统通知 | `tauri-plugin-notification` 2.8.0 | `Notification` 内建 | 平手；Windows toast 均依赖开始菜单快捷方式/AUMID（待验证） |
| 无边框透明置顶 | `decorations:false` + `transparent:true` + `alwaysOnTop`（[配置](https://v2.tauri.app/reference/config/)） | `frame:false` + `transparent:true` + `alwaysOnTop` | 平手，均有 Windows 透明渲染坑 |
| 点击穿透 | `setIgnoreCursorEvents`（[Window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)），Windows 实机行为**待验证** | `setIgnoreMouseEvents(ignore,{forward:true})`，Windows 官方支持（[文档](https://www.electronjs.org/docs/latest/api/browser-window)） | **Electron 更稳**，Tauri 是最大不确定项 |
| 多显示器 | 官方 monitor API 完整 | `screen` API 完整 | 平手 |
| 虚拟桌面 | 无官方 API（Windows 侧需 COM `IVirtualDesktopManager`，待验证） | `setVisibleOnAllWorkspaces` 在 Windows **官方注明 no-op** | 均需自行处理；不阻塞 v1 |
| 跳过任务栏 | `skipTaskbar` / `setSkipTaskbar` | `skipTaskbar` | 平手 |
| 全屏应用检测 | 需自行调 Windows Shell/Win32 API（`SHQueryUserNotificationState` 等，待验证） | 同样自行实现 | 平手，都要写 |
| 自启动 | `tauri-plugin-autostart` 2.7.0 | `setLoginItemSettings` | 平手 |
| 单实例 | `tauri-plugin-single-instance` 2.5.5 | `requestSingleInstanceLock` | 平手 |
| 自动更新 | `tauri-plugin-updater` 2.14.1，签名校验 + 静态 JSON endpoint，官方示例可直接用 GitHub Releases `latest.json`（[文档](https://v2.tauri.app/plugin/updater/)） | 内建 `autoUpdater`（需自建 update server 或第三方） | **Tauri 更省事** |
| 安装包体积 | 官方未给统一数字；空壳通常十几 MB 级（实测估计，待 spike）；WebView2 用 `embedBootstrapper` 只 +1.8MB（[官方数据](https://v2.tauri.app/distribute/windows-installer/)） | 通常 80–120MB（实测估计） | **Tauri 明显优** |
| 内存占用 | 官方无数据；社区常见结论为空壳 50–100MB 级（实测估计，待 spike） | 官方无数据；空壳 150–250MB 级（实测估计，待 spike） | Tauri 优，但需以 spike 为准 |
| WebView2 依赖 | 依赖系统 Evergreen Runtime；Win11 通常随 Edge 预装，Win10 可能缺 | 自带 Chromium，无外部依赖 | Electron 无依赖 |
| 后续 macOS | 支持，Windows 特有代码需隔离 | 支持，最成熟 | 平手 |

**Windows 透明/Acrylic 已知坑（必须 spike）：**
- 透明窗口需 `decorations:false` 且通常 `shadow:false`，否则出现黑边/白底；WebView2 透明渲染在部分显卡驱动下会闪烁。
- `windowEffects` 的 Mica/tabbed **仅限 Windows 11**；Acrylic 的 `color` 仅对 Win10 v1903+ 生效（[官方配置说明](https://v2.tauri.app/reference/config/)）。透明背景与系统材质叠加组合存在已知 issue（如 tauri [#12854](https://github.com/tauri-apps/tauri/issues/12854)）、透明窗口点击穿透仍被作为特性请求讨论（[#13070](https://github.com/tauri-apps/tauri/issues/13070)）。
- **结论**：先做 2 天 spike；若「置顶 + 透明 + 穿透 + 拖拽 + 不抢焦点」组合不可用，再评估 Electron 45（迁移面主要在窗口层，前端/数据层可复用）。

**不选 WinUI 3/WebView2 混合**：WinUI 3 无成熟「常驻悬浮窗 + 托盘 + 全局热键」的最小方案，需大量 Win32 互操作；前后端两套 UI 技术栈，对 2–3 人小团队成本过高。

## 3. 本地 ASR（中文普通话为主、中英混说）

sherpa-onnx 当前发布 **v2.0.1**（[releases](https://github.com/k2-fsa/sherpa-onnx/releases)），官方支持 C/Python/Rust 等 API，并内置 VAD（[VAD 文档](https://k2-fsa.github.io/sherpa/onnx/vad/index.html)）。

| 候选 | 模型体积（官方 HF 文件实际大小） | 中文质量 | 5–10s 短句延迟 | CPU 实时率 | 许可 | GPU | Rust 绑定 |
|---|---|---|---|---|---|---|---|
| **sherpa-onnx + SenseVoice-Small int8** | 228MB（fp32 894MB，[HF](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17)） | 官方称中文/粤语基准优于 Whisper（[SenseVoice README](https://github.com/QwenAudio/SenseVoice)） | 待实测；同仓库 llama.cpp 运行时称 44s 音频编码约 1.3s（CPU，官方数据） | 非自回归，预计 RTF 远小于 1（实测估计） | 代码 MIT；**权重为 FunASR Model License（非 OSI）** | ONNX Runtime CUDA EP（[官方 CUDA 文档](https://k2-fsa.github.io/sherpa/onnx/cuda.html)），本项目建议纯 CPU | `sherpa-onnx-sys` 2.0.1（官方 FFI，2026-10-27）；`sherpa-rs` 0.6.8 为社区封装、滞后（2025-10） |
| sherpa-onnx + Paraformer-zh int8 | 232MB（[HF](https://huggingface.co/csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14)） | 纯中文强，无中英混说能力 | 待实测 | 与上相近 | 权重同属 FunASR 许可 | 同上 | 同上 |
| sherpa-onnx streaming zipformer bilingual | ~189MB（int8：enc 173.5 + dec 12.5 + joiner 3.1） | 中英双语流式 | 可边说边出字 | 待实测 | Apache-2.0（sherpa-onnx 项目） | 同上 | 同上 |
| whisper.cpp / whisper-rs | large-v3-turbo 级模型 1GB+（官方模型页，待核实具体量化体积） | 多语种好，中文短句常弱于 SenseVoice（社区共识，待自测） | CPU 上大模型偏慢 | 低于非自回归 | 代码/模型均 MIT | 支持 CUDA | whisper-rs 0.16.0（2026-03） |
| faster-whisper（Python） | 同 Whisper 权重 | 同上 | 依赖 Python 运行时 | 较好 | MIT | CUDA | 无（需 PyInstaller 侧车） |

**推荐**：默认 SenseVoice-Small int8（228MB，中英混说最佳性价比）；中文专用/许可兜底选 Paraformer-zh int8；低配机器（8GB 内存/老 CPU）用 Paraformer-zh-small int8（78MB）。流式 zipformer 只用于「边说边显示」的体验增强，不作为 v1 必须项。

**GPU**：不依赖。10s 音频在 16 核 CPU 上预计 0.3–1.0s（实测估计，含 VAD/特征），CUDA EP 会把安装包和驱动兼容成本抬高，收益有限；仅在 spike 不达标时启用。

## 4. 本地 LLM 结构化抽取（一句话 → JSON 待办数组）

**引擎**：llama.cpp（最新 tag **b12024**，[releases](https://github.com/ggml-org/llama.cpp/releases)）+ Rust 绑定 **llama-cpp-2 0.1.160**（[docs.rs](https://docs.rs/llama-cpp-2)，2026-10，含 Grammar sampler 与 `cuda` feature）。约束解码用 [GBNF 语法](https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md)（由 JSON Schema 或手写生成），把输出锁进 `{todos:[{title,due,repeat,subtasks:[]}]}`，避免解析失败重试；llama-cpp-2 暴露 Grammar 采样器，`llama-server` 侧车可通过请求参数传 grammar（JSON schema 字段名**待验证**）。

| 模型（GGUF） | 体积（官方 HF 实测） | 许可 | 定位 | 备注 |
|---|---|---|---|---|
| **Qwen3.5-4B Q4_K_M** | 2614MB（[unsloth GGUF](https://huggingface.co/unsloth/Qwen3.5-4B-GGUF)）；IQ4_XS 2362MB；Q3_K_M 2187MB | Apache-2.0（[Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B)） | **有 GPU / 16GB 内存默认** | 2026-03 发布；`UD-IQ2_M` 1678MB 可作 12GB 内存档 |
| Qwen3.5-2B / 0.8B | 未取到现成量化尺寸（估计 1.2GB / 0.5GB Q4，**实测估计**） | Apache-2.0 | **无 GPU 默认 / 低配** | 输出短 JSON 场景 0.8B 可能够用，需 eval |
| Qwen3-4B-Instruct-2507 | 未取到量化尺寸（**待验证**） | Apache-2.0 | 备选（非思考型，抽取更稳） | 若 Qwen3.5 指令跟随异常可回退 |
| Qwen3-1.7B / Qwen3-0.6B | 1749MB / 610MB（Q8_0，官方 HF） | Apache-2.0 | 极低配兜底 | 仅作兜底 |

**性能预算（RTX 4060 Laptop 8GB / Ryzen 9 7945HX，实测估计，待 spike）**：
- 有 GPU（llama.cpp CUDA，4B Q4 全量约 2.6GB 显存）：预计 40–80 tok/s，80–150 输出 token → 1–3s。
- 纯 CPU（16C/32T，4B Q4）：预计 8–15 tok/s → 8–15s，**超 3s 预算**，故 CPU 默认降到 2B/0.8B + 规则兜底。
- 优化：系统提示词固定以复用 KV cache、输出上限 160 token、约束语法直接产出短字段。

**Ollama（MIT）**仅建议作为开发期对照与评测工具，不作为产品依赖：需独立安装/常驻服务、版本不可控、安装包大；模型与 llama.cpp 同源，收益低。注：Qwen2.5 系列（3B/1.5B）已被 Qwen3/3.5 取代，只在极端兼容场景保留评测对照。

**规则兜底**：中文时间表达（明天/下周三/三点半/每周一）、重复（每天/工作日）、分句（「和/还有/，」）用 Rust 规则库直接解析；LLM 超时（3s）或 JSON 校验失败时走规则，保证「零确认」路径永不被阻塞。

## 5. 运行时集成架构

**推荐 v1：独立侧车进程 `clarify-engine.exe`（C/C++ 静态链接 llama.cpp + sherpa-onnx，Rust 薄壳）**，Tauri 主进程通过 stdio JSON-RPC 管理。

| 维度 | 进程内 Rust 库 | 侧车进程（推荐） |
|---|---|---|
| 崩溃隔离 | C++ 段错误会拖垮 UI 进程 | 引擎崩溃仅重启侧车 |
| 内存回收 | 释放模型依赖 C++ 析构，易残留 | 空闲 5 分钟直接 `kill`，内存 100% 归还 |
| 升级 | 引擎升级 = 整包更新 | 可单独替换 exe/模型 |
| 延迟 | 无 IPC | IPC 开销 <5ms，可忽略 |
| 复杂度 | 低（单进程） | 中（协议、守护、超时） |

**模型下载与校验**：内置 `models.json` 清单（URL、size、sha256、量化档）；`reqwest 0.13.5` 流式下载 + HTTP Range 断点续传；国内提供 Hugging Face 镜像（hf-mirror.com）作为备用 endpoint；校验通过后写 `.ok` 标记；失败可续；模型存 `%LOCALAPPDATA%\Clarify\models\`（约 3GB，与安装目录分离，卸载可选择保留）。首次运行向导：检测 GPU → 选择模型档 → 下载（显示体积/进度/可暂停）→ 试听麦克风。

**录音采集**：`cpal 0.18.2` WASAPI 共享模式（44.1/48kHz）→ `rubato 5.0.1` 重采样到 16kHz 单声道 → sherpa-onnx 内置 Silero VAD（MIT，[silero-vad](https://github.com/snakers4/silero-vad)）断句；PTT 语义 = 按下热键开始录音、松开后等 VAD 判定尾部静音即停（最长 15s 保护）。麦克风权限/设备热插拔需兜底提示。

**提醒调度可靠性**：应用常驻托盘是主路径——`tokio` 30s tick + 监听系统唤醒/登录事件后**对账式**扫描 SQLite 中 `due_at <= now` 的未提醒项（避免睡眠期间漂移）。应用完全退出时：v1 用「下次启动补发 + 托盘常驻」保证不丢；v2 用 Windows 计划通知（`ToastNotifier.AddToSchedule`，[官方文档](https://learn.microsoft.com/windows/apps/develop/notifications/app-notifications/app-notifications-scheduled)）或任务计划程序，需带 AUMID 的安装快捷方式（**待验证** NSIS 安装包下 toast 的 AUMID 行为）。

**GPU 检测**：`sysinfo` 0.40.1 查内存/CPU + DXGI 枚举/NVML 查显卡与显存；仅在显存 ≥4GB 时启用 CUDA 侧车，否则 CPU 档。

## 6. 数据层

- **rusqlite 0.41.1（`bundled` feature，内置 SQLite，无系统依赖）+ refinery 0.10 迁移**；WAL、`foreign_keys=ON`、单写线程（actor 模式）。业务写入全在 Rust 侧，前端走 `invoke`。
- 备选 `tauri-plugin-sql` 2.6.0（内部 sqlx 0.9.0，[文档](https://v2.tauri.app/plugin/sql/)）：适合前端直接 SQL，但会让迁移与事务边界跨语言，不推荐作为主方案。
- 表：`todos`（id/title/due_at/repeat_rule/completed_at/source/created_at）、`todo_meta`、`settings`、`model_manifest`；索引 `due_at`、`completed_at`。已完成 24h 自动隐藏 = 查询层过滤 + 每日清理任务，不物理删除（保留撤销）。
- 备份：每日启动时 `VACUUM INTO` 到 `%APPDATA%\Clarify\backups\`，滚动保留 7 份；导出 JSON/Markdown（不含音频）。

## 7. 前端

- **React 19.3.1 + TypeScript 7.0.2 + Vite 8.3.5 + Tailwind CSS 4.3.3 + shadcn/ui**（npm 最新，2026-11-01）。状态管理 zustand 5.0.16；i18n 用 i18next 26.6.0（zh-CN / en，文案分文件）。
- **双窗口双入口**：Vite multi-page 配置 `index.html`（主窗口）+ `overlay.html`（悬浮窗），Tauri 用两个 Window label；悬浮窗只渲染视图卡片 + 拖拽区，数据经 Tauri event 增量推送，不跑解析逻辑，降低内存与首屏时间。窗口位置/尺寸用 `tauri-plugin-window-state` 持久化。
- 悬浮窗参数：`transparent:true`、`decorations:false`、`alwaysOnTop:true`、`skipTaskbar:true`、`shadow:false`、`resizable:false`；点击穿透通过 Rust 端 `set_ignore_cursor_events` 按设置切换（与「拖拽/点击完成」的交互冲突需产品先定义，参见 §2 风险）。

## 8. 技术尖峰（spike）验证清单

本机（Win11 22621 / 7945HX / 16GB / RTX 4060 8GB）实际执行，**未达标项决定是否改架构**：

| # | 项目 | 方法 | 验收阈值 |
|---|---|---|---|
| 1 | 热键 → 开始录音 | Rust 时间戳：shortcut 回调 → cpal 首帧 | **<150ms** |
| 2 | 10s 语音端到端转写 | 10 条真实录音（含中英混说/数字/时间），cold/warm 各 5 次 | **<2s**（P95） |
| 3 | JSON 解析（4B/2B） | 50 条真实一句话样本，grammar 约束，记录 P50/P95 | **<3s**（P95），JSON 合法率 ≥99% |
| 4 | 抽取准确率 | 上述 50 条人工标注（标题/时间/重复/拆分四字段） | 字段准确率 **≥90%** 才可默认用 LLM |
| 5 | 常驻内存 | 主进程+WebView2+侧车常驻，任务管理器/`Get-Process` | **<300MB** |
| 6 | 峰值内存 | 录音+转写+解析同时 | **<4GB** |
| 7 | 冷启动到悬浮窗可见 | 秒表/日志 | **<2.5s** |
| 8 | 安装包体积（不含模型） | `cargo tauri build` | **<80MB** |
| 9 | 空闲 CPU | 托盘 30 分钟平均 | **<1%** |
| 10 | 悬浮窗组合行为 | 手测：置顶/穿透/拖拽/多显示器/DPI 150%/虚拟桌面切换 | 无白底黑边、不抢焦点、穿透可开关 |
| 11 | 全屏应用不打扰 | 全屏 3D 游戏/视频下触发待办显示 | 不弹窗或按设置抑制（API 选型待验证） |
| 12 | 睡眠唤醒提醒 | 设 1 分钟后提醒 → 睡眠 2 分钟 → 唤醒 | 漂移 **<5s**（对账式扫描） |
| 13 | 模型下载 | 断网/限速/暂停续传，校验 sha256 | 续传成功、坏包拒绝 |
| 14 | 24h 自动隐藏 | 完成时间跨 0 点边界 | 恰好 24h 后从悬浮窗消失 |

前置：安装 Rust stable（rustup），`pnpm create tauri-app` 空壳跑通；ASR 用 sherpa-onnx Python wheel 先验模型效果，再接 Rust。基准工具优先用官方 CLI（如 llama.cpp `llama-bench`）与自写计时脚本，结果写入 `docs/research/spike-results.md`（待建）。

## 9. 风险与未决问题

1. **最高风险：Tauri 透明置顶悬浮窗 + 点击穿透 + 拖拽在 Win11 的组合行为**（已知 issue 见 §2）。第 1 周 spike 决定壳选型；迁移到 Electron 的成本主要在窗口层，前端与数据层可复用。
2. **ASR 权重许可**：SenseVoice 权重是 FunASR Model Open Source License（非 OSI），官方澄清允许商业使用但需遵守署名/模型名条款（[README](https://github.com/QwenAudio/SenseVoice)）。若法务不接受，切 Paraformer 或 whisper 系 MIT 模型（体积/中文精度做取舍）。
3. **Windows 代码签名**：无签名安装会触发 SmartScreen 告警；新证书需 HSM/云签名（[微软签名选项](https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options)），成本与流程**待核实**。v1 可先内测分发（用户手动信任），公测前必须解决。
4. **WebView2 依赖**：Win11 一般已预装，Win10/精简版可能缺失；`downloadBootstrapper` 需联网（与「完全本地」在首次安装阶段冲突），建议 `embedBootstrapper`（+1.8MB）或对老旧机器提供离线包（+127MB）。
5. **模型下载体验**：默认 ASR 228MB + LLM 2.6GB，国内网络波动；需镜像、断点续传、sha256、可选「先只装 ASR 的轻量模式」。
6. **Qwen3.5 较新（2026-03）**，中文结构化抽取质量无公开基准；必须自建 50–100 条 eval，且保留规则兜底。
7. **无服务器自动更新**：用 GitHub Releases 静态 `latest.json`（Tauri 官方示例）可不自建服务器，但依赖 GitHub 可达性；国内需备用下载页（手动安装包）。
8. **多显示器/虚拟桌面/全屏检测**：均需自行实现 Win32/COM，行为未验证；v1 可先只保证主显示器 + 简单全屏抑制。
9. **待验证清单**：Tauri `setIgnoreCursorEvents` Windows 实机效果；NSIS 安装下 toast AUMID；llama-server JSON schema 字段名；Qwen3-4B-Instruct-2507 量化体积；whisper 各量化模型精确体积。
