# M1 后端与底层进度（2026-11-01）

## 环境结论

- **MSVC 已安装并验证**（2026-11-01 19:40）：Visual Studio Build Tools 2022，`cl.exe 14.44.35207`，Windows 11 SDK 22621。
  - 验证命令（Developer PowerShell 环境）：
    ```powershell
    cmd /c "call `"C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" && cargo test -p clarify-core && cargo build -p clarify"
    ```
  - 结果：`clarify-core` 7/7 测试通过；`target/debug/clarify.exe` 构建成功并启动运行（MSVC 产物约 15MB）。
- **备用 GNU 工具链**（无管理员权限时使用）：便携 MinGW + Rust `stable-x86_64-pc-windows-gnu`；初始化 `. .\scripts\dev-env.ps1`。两条工具链均可构建，正式发布默认用 MSVC。
- `pnpm build`（前端 Vite）通过。

## 已实现（backend core）

`core/` 独立 crate（不依赖 Tauri，可单测）：

- `clock.rs`：`Clock` 抽象（now_utc / local_date / local_week_key），`SystemClock` + 测试用 `FixedClock`（可推进）。
- `model.rs`：`NewEvent`/`Event`、字段校验（标题、时间三精度、时段+截止、重复、计数互斥、周几）、`advance_repeat`（日/周/月，周几）、计数周期键。
- `store.rs`：SQLite schema（events / event_completions / settings / schema_migrations，WAL、外键、索引）、CRUD、完成/恢复、计数 +1（可超额、周期边界复位）、24h 物理清理、完成日志、重复任务下一次推进。
- 单测 **7/7 通过**（`cargo +stable-x86_64-pc-windows-gnu test -p clarify-core`）：
  - 计数与时间互斥、重复必须有时基
  - 计数允许 4/3、跨天复位、永不 24h 删除
  - 单次完成/恢复
  - 重复任务推进下一次且系列不完成、可恢复
  - 完成 24h 后物理删除
- `src-tauri/src/lib.rs`：Tauri commands（list_open/list_completed/create/complete/restore/increment_count/delete/purge）、启动时打开 `%LOCALAPPDATA%/com.clarify.desktop/clarify.db` 并执行一次清理、注入 `SystemClock`。

## 下一步

1. 前端壳：把 `prototype-v0.5` 的视觉接入 React（主窗 A/B、详情抽屉、设置、已完成折叠），接 IPC。
2. 悬浮窗：Tauri 第二 WebviewWindow（300×220 / 260，时间线标记、下拉拉伸、计数 +1）。
3. AI 网关客户端：`/v1/transcribe`、`/v1/parse`（先 mock/规则模式），激活码/额度状态。
4. M1 验收：核心用例 E2E + 性能（热键→创建、24h 清理、计数边界）。
