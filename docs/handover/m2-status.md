# M2 进度：React 主窗壳 + IPC（2026-11-01）

## 已完成

- `src/api.ts`：Tauri `invoke` 封装（list_open / list_completed / create / update / complete / restore / increment_count / delete），浏览器环境自动使用 mock 数据（便于预览与视觉走查）。
- `src/App.tsx`：主窗口壳
  - 顶栏（品牌/日期/A-B 切换/设置/窗口按钮，原生无边框拖动区）
  - A 时间轴：一天（时间点短线、时间段上下时间+细竖线）、7 天周视图、日历月视图
  - B 清单：今天/全部，勾选圈完成、计数 chip（4/3）
  - 右侧详情抽屉：标题、日期、开始/结束、重复、计数目标/周期；保存/完成/+1/删除
  - 已完成折叠 + 恢复；底部捕捉条（文字创建，AI/语音 M3 接）
  - 设置：雾粉/鼠尾草/雾蓝石墨三主题切换（localStorage），无夜间模式
- `src/styles.css`：暖纸 + 纯白卡 + 珍珠灰 + 三主题 tokens，对齐 `12-visual-spec.md v1.0`（简化实现，非最终像素级）。
- 构建验证：
  - `pnpm build` 通过
  - `cargo test -p clarify-core` 7/7 通过（含 update 后）
  - `cargo build -p clarify`（MSVC）通过，`target/debug/clarify.exe` 启动运行 4 秒无崩溃
- 预览截图：`docs/screenshots/m2-main-window.png`

## 已知差异 / 下一步

1. 悬浮窗（第二 WebviewWindow）尚未实现：300×220 / 300×260、时间细线、下拉拉伸、内部滚动、高度记忆、点任务完成。
2. AI 网关客户端未接：先 mock + 规则模式；官方 `/v1/transcribe`、`/v1/parse`、激活码/额度状态。
3. 视觉仍是简化 CSS，等悬浮窗与主窗功能齐后按 v1.0 做像素级打磨。
4. 主窗窗口位置/尺寸记忆、关闭=隐藏、设置页"退出"（Q20）尚未接。
5. 无托盘图标（按 Q20 已确认不做）。
