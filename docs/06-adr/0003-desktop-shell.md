# ADR-0003：桌面壳选型（Tauri 2 优先，Electron 备选）

- 状态：Proposed（需 spike S4 验证悬浮窗组合行为）
- 日期：2026-11-01
- 关联：`docs/research/tech-stack.md` §2

## 背景

Clarify 需要：常驻置顶悬浮窗（透明/毛玻璃、可移动、可缩放）、全局快捷键、托盘/后台、本地 SQLite、进程内/轻量网关调用，并且安装包与内存越小越好。

## 决策

- 首选 **Tauri 2.12.x**（Rust 主进程 + WebView2 双窗口），前端 React 19 + TypeScript + Vite + Tailwind + shadcn/ui。
- Electron 45.x 作为备选：若 Win11 上"透明 + 置顶 + 点击穿透 + 拖拽 + 不抢焦点"组合无法达标，则切换（窗口层重写，前端与数据层可复用）。
- **Spike S4 验收项**：无边框透明窗口无黑边/白底；置顶不抢焦点；拖动/缩放；多显示器/DPI 150%；全屏应用时自动隐藏或抑制；内存与包体达标。

## 后果

- 正面：包体小、内存低、Rust 侧可直接做 DB/录音/HTTP；跨平台留门。
- 负面：WebView2 透明渲染与 Acrylic 在 Windows 有已知坑；需额外 Win32 处理全屏检测；团队需 Rust 能力。
- 若 spike 失败，切换 Electron 的成本主要在窗口层，业务逻辑可保留。

## 关联

`04-architecture.md`、`docs/research/tech-stack.md`、`docs/research/spike-results.md`
