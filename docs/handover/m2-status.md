# M2 进度：主窗 + 悬浮窗接入（2026-11-01）

## 已完成

### 主窗口（React + 真实 IPC）
- 顶栏：品牌/日期/A-B 切换/设置/无边框窗口按钮与拖动区
- A 时间轴：一天（时间点短线、时间段上下时间+细竖线）、7 天周视图、日历月视图
- B 清单：今天/全部，勾选完成、计数 chip（4/3）
- 详情抽屉：标题/日期/开始结束/重复/计数目标与周期；保存/完成/+1/删除
- 已完成折叠 + 恢复；底部捕捉条（文字创建）
- 设置：雾粉/鼠尾草/雾蓝石墨三主题（localStorage）
- 主窗关闭 = 隐藏（Rust `on_window_event`），不退出进程
- “还有 N 件” → 调用 `open_main_today`：显示主窗 + 发 `clarify://open-today` 事件，主窗切到 Today 并保持上次模板

### 悬浮窗（Tauri 第二 WebviewWindow）
- `overlay.html` 独立入口（Vite 多页），Rust 启动时创建窗口 label=`overlay`
- 300×220 起，最小 300×180、最大 300×420；透明、无边框、置顶、不占任务栏、shadow=false
- A 模板：今天 + 日期 + 进度；最多按高度显示 3+ 条时间事项；footer「＋说一句 / 还有 N 件」
- B 模板：今天/全部 toggle；最多 4+ 条
- 时间标记：点=时间后短线；段=上下两行时间+中间细竖线
- 点任务=完成（计数=+1，可 4/3）；「还有 N 件」跳主窗 Today；⌂ 回主窗
- 底边拖动 = 拉伸高度（`startResizeDragging("South")`）；高度记忆 localStorage
- 主题跟随主窗（localStorage）；右下角 A/B 切换按钮

### 验证
- `pnpm build` 通过（main + overlay 双入口）
- `cargo build -p clarify`（MSVC）通过
- 实际启动：主窗 + 悬浮窗同时显示；用 seed 数据验证时间轴/计数/悬浮窗渲染
- 截图：`docs/screenshots/m2-app-seeded.png`（真实 Tauri 窗口 + 悬浮窗）

## 待办 / 下一步
1. AI 网关客户端：mock + 规则模式 → `/v1/transcribe`、`/v1/parse`、激活码/额度状态
2. 主窗窗口位置/尺寸记忆；设置页“退出 Clarify”；悬浮窗位置记忆/多屏
3. 捕捉条接语音（ASR）与 AI 解析；乐观 UI 与失败兜底
4. 视觉像素级打磨（行高/阴影/衬线/玻璃细节）；B 模板/计数完成后刷新体验
5. 打包（NSIS）与签名准备（发布阶段）
