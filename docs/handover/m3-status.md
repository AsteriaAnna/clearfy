# M3 进度：规则解析 + 捕捉链路 + 全局热键（2026-11-01）

## 已完成

### 规则解析（`core/src/rules.rs`）
无 AI / 离线兜底，只解析明确内容，不猜：

- 日期：今天/明天/后天/大后天、下周X、周X、星期X
- 时刻：`N点` / `N点半` / `N点M分` / `HH:MM`；上午/下午/中午/晚上做 12 小时制修正（仅当出现明确时刻）
- 重复：每天、每周X（绑定周几）
- 计数：每天 N 杯/次/个/遍 → count_target + count_period=day（与重复互斥）
- 拆句：按逗号/分号/换行拆分，每段独立解析
- 标题清洗：去掉时间词、日期词、提醒我/记得/帮我等前缀；空标题回退原句
- 时区：输入本地日期 + 当前 UTC offset，输出 UTC ISO

单测新增 4 个（共 **11/11** 通过）：
- 明天下午三点 → `2026-11-02T07:00:00Z`
- 每周一10:00 → repeat week + weekdays=[1]
- 每天喝三杯水 → count 3/day
- 逗号拆两句，第二句无时间

### 捕捉链路
- 新增 Tauri command `create_from_capture(text)`：规则解析 → 逐条创建事件 → 返回创建结果
- 主窗捕捉条改为调用该命令；成功显示「已创建 N 项 ✓」，失败显示错误
- 占位提示更新为可试例句（如“明天下午三点开会”）

### 全局热键
- 接入 `tauri-plugin-global-shortcut`
- `Ctrl+Alt+Space`：显示主窗 + 聚焦 + 发射 `clarify://capture` → 主窗聚焦捕捉输入框
- 启动时注册热键；已实测应用启动正常（无热键冲突）
- 悬浮窗仍常驻置顶；`Ctrl+Alt+W` 待后续补（避免与常见快捷键冲突）

## 验证
- `cargo test -p clarify-core`：11/11 通过（GNU + MSVC 均验证核心）
- `cargo build -p clarify`（MSVC）通过
- 应用启动冒烟通过；热键注册成功

## 下一步
1. **AI 服务设置**：设置表 + 命令（规则/官方网关/BYOK），激活码/网关 URL 存储（Key 走 Windows 凭据管理器）
2. **网关客户端**：`/v1/transcribe`、`/v1/parse`（需要网络；先 mock 服务/契约测试）
3. **语音**：录音 + 上传 + 失败兜底（等用户提供 ASR Key 或部署官方网关后联调）
4. 视觉打磨与窗口位置记忆；准备第一个可安装包

---

# AI 真实接入（2026-11-01 晚，追加）

## DeepSeek（已通）

- 新增 `src-tauri/src/ai.rs`：`deepseek_parse` 调用 `deepseek-flash`（JSON Output + `thinking: disabled`）
- 新增命令：`ai_parse`（AI 解析→创建，失败自动回退规则）、`ai_status`、`save_ai_keys`
- 主窗捕捉条改为 `aiParse`；成功显示「AI 已安排 N 项 ✓」，失败/未配置显示规则模式说明
- Key 存本机 `%LOCALAPPDATA%\com.clarify.desktop\ai-config.json`（开发期明文，不进仓库/文档/日志；正式版迁移 Windows 凭据管理器）
- **端到端实测通过**：全局热键 → 捕捉条 → DeepSeek → 创建 2 条
  - 输入“明天下午三点跟张总开会，顺便买牛奶”
  - 创建：`跟张总开会`（`2026-11-02T07:00:00Z`）+ `买牛奶`（无时间，标题已去掉“顺便”）
  - 截图：`docs/screenshots/m3-ai-capture.png`

## 豆包语音（已通，流式 2.0）

- Key 鉴权：`X-Api-Key`（新版豆包语音控制台 API Key）
- 用户已开通「录音文件识别」与「大模型流式语音识别」；**优先流式**
- 流式实现：`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`
  - `X-Api-Resource-Id: volc.seedasr.sauc.duration`（2.0 小时版；`concurrent` 也可）
  - 二进制协议：full client request（JSON）→ audio-only 200ms/包 → final flag；服务端 gzip JSON 响应
- 前端录音：WebView2 `getUserMedia` → WebAudio `ScriptProcessor` 采集 → 16k/16bit/mono PCM → base64
- 命令：`transcribe_stream(pcm_base64)` → 识别文本 → `ai_parse` → 创建
- **端到端实测通过**：
  - 用 Windows TTS 生成“明天下午三点跟张总开会，顺便买牛奶”音频，Chromium fake-audio 设备驱动麦克风
  - CDP 点击录音 → 识别 `明天下午3点跟张总开会。` → DeepSeek → 创建 `跟张总开会`（2026-11-02 15:00）
  - 截图：`docs/screenshots/m3-voice-stream.png`
- 全局热键：
  - `Ctrl+Alt+Space`：显示主窗 + 聚焦文字捕捉
  - `Ctrl+Alt+V`：显示主窗 + 开始/停止语音捕捉
- 录音文件极速版（flash, `volc.bigasr.auc_turbo`）仍返回 403 未授权；当前不使用，保留代码作为非流式备选

## 安全提醒

- 两个 Key 已在对话中出现；建议本轮测试后在控制台重置/轮换
- 本仓库不含 Key（已 grep 确认）；Key 只在 AppData 本地配置中

