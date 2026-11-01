# Tauri IPC 契约（tauri-ipc）

- Owner：tech-writer（技术与工程文档）
- 版本：v0.3（计数语义用户确认稿；v0.2 红队修复稿）
- 更新日期：2026-11-01
- 本次修订（v0.3，用户确认 2026-11-01）：计数语义同步——`+1` **不封顶**（`count_progress` 可大于 `count_target`，如 4/3）、计数**无完成态**（不写 `completed_at`、不进"已完成"折叠、无 24 h 删除、无"恢复"）、仅周期边界复位；`ViewResult.completed` 移除 `counts`；命令名按 Lead 口径统一为 `event.increment_count`（原 `event.count_increment`）。修订章节：§1.1、§1.3、§3、§4.10、§4.11、§4.12、§5、§9、§12。
- 状态：**v1 冻结候选**。领域字段与语义的**唯一事实源是 `03-domain-model.md`**；错误码见 `05-contracts/error-taxonomy.md`；设置结构见 `05-contracts/config-schema.md`；AI 输出见 `05-contracts/ai-json.md`；网关 HTTP 见 `05-contracts/gateway-api.md`。
- 关联：`04-architecture.md` §3/§4/§5

---

## 0. 约定

1. **命令名**：文档用逻辑名 `domain.action`，Rust 导出为 `domain_action`（如 `capture.start` ↔ `capture_start`，前端 `invoke("capture_start", {...})`）。事件名直接使用点号字符串（如 `event.created`）。
2. **字段命名**：所有领域字段用 **snake_case**，与 `03-domain-model.md` §2 **逐字一致**（`due_start_at`、`count_period_key`…）；非领域参数（`op_id` 等）同为 snake_case。禁止前端另造同义字段。
3. **时间**：所有 `*_at` 为 UTC ISO 8601（`YYYY-MM-DDTHH:MM:SSZ`，秒固定 `00`）；`due_date` 为本地日历日 `YYYY-MM-DD`；`*_date` 同理。前端展示按系统时区换算（规则见 domain §6、§4）。
4. **ID**：`id` 为 UUID v7 字符串；`batch_id`/`capture_id` 为 `cap_` + 26 位 Crockford Base32；`op_id` 为 UUID v4。
5. **统一结果信封**：命令成功 = 直接返回数据；失败 = 抛结构化错误（§2.4）。Tauri 命令实现统一 `Result<T, AppError>`，序列化为 `{ "error": {...} }` 形状由前端 `ipc.ts` 解包。
6. **前端能力（capability）**：`main` 窗口可用全部命令；`widget` 窗口只允许 §9 白名单命令。越权调用返回 `CLR-E0001`（视为前端 bug）。
7. **幂等**：所有**写命令**接受可选 `op_id`；后端对同一 `op_id` 在 60 s 内去重（返回首次结果）。`ai_parse` 以 `capture_id` 作为天然幂等键（重复调用返回已创建的事件，不重复创建）。
8. **乐观 UI 的边界**：前端可先本地标记完成/隐藏，但以命令返回或 `event.*` 事件为最终一致；失败必须回滚并提示（§8）。

---

## 1. 公共类型

### 1.1 `Event`（领域实体的 IPC 视图）

字段与 `03-domain-model.md` §2 一致，另含只读派生字段（不参与写入）：

```json
{
  "id": "0198f3c4-7a1b-7c2d-8e3f-4a5b6c7d8e9f",
  "title": "跟张总开会",
  "due_date": null,
  "due_start_at": "2026-11-02T07:00:00Z",
  "due_end_at": null,
  "deadline_at": null,
  "repeat_freq": null,
  "repeat_interval": 1,
  "repeat_weekdays": null,
  "count_target": null,
  "count_period": null,
  "count_progress": 0,
  "count_period_key": null,
  "created_at": "2026-11-01T08:30:00Z",
  "completed_at": null,

  "time_kind": "datetime",
  "shape": "single",
  "status": "open",
  "is_overdue": false,
  "expires_at": null,
  "current_period_key": null
}
```

| 派生字段 | 取值 | 规则来源（唯一事实源） |
|---|---|---|
| `time_kind` | `none` \| `date` \| `datetime` \| `range` | domain §2.1 |
| `shape` | `single` \| `recurring` \| `count` \| `untimed` | domain §3 |
| `status` | `open` \| `done` | domain §3（周期型事件行恒为 `open`；**计数型恒为 `open`**——无完成态） |
| `is_overdue` | bool | domain §11.2 |
| `expires_at` | UTC ISO \| null | domain §3（单次/无时间型 completed+24h；周期完成日志各自计算；计数型为 null） |
| `current_period_key` | string \| null | domain §8.3（仅计数型） |

- 写入类命令**不接受**派生字段（传了忽略并记日志，不报错）。
- **计数型（用户确认 2026-11-01）**：`count_progress` 允许大于 `count_target`（如 4/3，目标仅作显示参照）；`status` 恒为 `open`、`expires_at` 恒为 `null`；不写 `completed_at`、不产生完成日志、不进"已完成"折叠、无 24 h 删除，仅周期边界（日/周）复位。
- `repeat_interval` 缺失时后端归一为 1（domain §13.1 C11，storage-schema 归一化规则）。
- `repeat_weekdays`：IPC 用数组（`number[] | null`），存储层为规范化 JSON 文本（storage-schema §5.1）；Rust DTO 负责双向转换，前端不接触字符串形式。
- 前端显示文案（时间文案/重复文案/倒计时）按 `03-domain-model.md` §4 实现于共享前端模块，不在 IPC 重复下发，避免多窗口不一致。

### 1.2 `OccurrenceCompleted`（周期型"这一次"的完成日志视图）

```json
{
  "id": "comp_01J9Z2M4Q8Y6T1V3W5X7Y9Z1B3",
  "event_id": "0198f3c4-...",
  "title": "每天跑步",
  "occurrence_due_date": null,
  "occurrence_start_at": "2026-11-01T23:00:00Z",
  "occurrence_end_at": null,
  "occurrence_deadline_at": null,
  "completed_at": "2026-11-02T00:10:00Z",
  "expires_at": "2026-11-03T00:10:00Z"
}
```

- 字段口径：`event_completions`（domain §7.1）+ 联表取的 `title`（日志不存标题）+ 派生 `expires_at`。
- 仅周期型产生；恢复时用 `id`（必须是该事件**最新**一条，否则 `CLR-E5009`）。

### 1.3 `ViewQuery` / `ViewResult`

```ts
type ViewQuery =
  | { kind: "timeline_day";   window: "main";   date: "YYYY-MM-DD" }
  | { kind: "timeline_day";   window: "widget" }                       // 固定当天
  | { kind: "timeline_week";  window: "main";   start_date?: "YYYY-MM-DD" } // 默认今天起 7 天
  | { kind: "timeline_month"; window: "main";   month: "YYYY-MM" }
  | { kind: "list";           window: "main" | "widget"; scope: "today" | "all" };
```

```json
{
  "query": { "kind": "list", "window": "main", "scope": "today" },
  "generated_at": "2026-11-02T09:00:00Z",
  "time_range": { "start": "06:00", "end": "24:00" },
  "sections": [
    { "key": "overdue", "events": [] },
    { "key": "today", "events": [] },
    { "key": "untimed", "events": [] }
  ],
  "days": null,
  "outside_range": [],
  "completed": {
    "events": [],
    "occurrences": [],
    "total": 0,
    "next_purge_at": "2026-11-02T15:30:00Z"
  },
  "truncated": null
}
```

| 字段 | 适用 | 说明 |
|---|---|---|
| `time_range` | timeline（main/widget） | 生效的时间范围（来自 `settings.views.*.timeline.range`）；`list`/`month` 为 null |
| `sections` | list | 分组：`overdue` / `today` / `later` / `untimed`；**main**：`scope=today` → `[overdue, today, untimed]`，`scope=all` → 四组全含（domain §11.1：B 今天 = 逾期+今天+无时间与打卡） |
| `days` | timeline_day/week/month | `[{date, events}]`：day=1 天；week=连续 7 天（domain §11.1：从今天起）；month=当月每日（**仅已安排事件**，格子最多 3 条由前端按 domain 规则展示，数据不裁剪） |
| `untimed` | timeline main | 轴下方"无时间与打卡"区（无时间型 + **全部计数型，不论 `count_progress` 是否达到/超过 `count_target`**；按 domain §11.3 排序；计数显示 `progress/target · 周期`，如 4/3） |
| `outside_range` | timeline main | 因时间范围裁选而未上轴的事件（完整事件；选区内事件已**整条**包含，不裁剪时段，见 domain/产品决策 §5） |
| `completed` | 所有 main 视图 | `events`=单次/无时间型 24 h 内；`occurrences`=周期日志 24 h 内；`next_purge_at`=最早到期时间（无则 null）。**不含计数型**（计数无完成态、不进折叠、无 24 h 删除） |
| `truncated` | widget | `{shown, hidden}`：悬浮窗上限 **5 条**（charter 清晰规则）。widget 不返回 `untimed`/`outside_range`/`completed`（domain §11.1 悬浮窗规则），`sections`/`days` 已裁剪 |

**widget 行为**（`window: "widget"`）：`timeline_day` 返回逾期 + 今天、最多 5 条（`days=[{date:今天, events:[...]}]`，`sections=null`）；`list` 返回今日/全部前 5 条（`sections` 裁剪、`truncated` 必填）。无时间与打卡、已完成不占悬浮窗主区。

### 1.4 `ServiceStatus`

```json
{
  "mode_preference": "official",
  "asr":  { "source": "official", "provider": "aliyun_bailian", "model": "paraformer-realtime-v2", "available": true },
  "parse": { "source": "official", "provider": "deepseek", "model": "deepseek-flash", "available": true },
  "official": {
    "gateway_url": "https://<fc-default-domain>",
    "activation": "active",
    "quota": { "limit": 200, "used": 37, "remaining": 163, "reset_at": "2026-11-02T00:00:00+08:00" },
    "budget": { "state": "ok", "used_cny": 36.42, "limit_cny": 200.0 }
  },
  "byok": { "parse_configured": false, "asr_configured": false },
  "network": "online",
  "last_checked_at": "2026-11-02T09:00:00Z",
  "notice": null
}
```

- `mode_preference`：设置里的偏好（`official`/`byok`/`rules`）；`asr.source`/`parse.source` 是**本次可用性解析结果**（domain/架构 §5.1 的能力级降级；`unavailable` 表示语音不可用）。
- `activation`：`none` \| `active` \| `invalid` \| `revoked` \| `unknown`。
- `notice`：非错误提示（如"官方额度今日用完，当前用规则模式"），前端以轻提示呈现，可为 null。
- 该结构仅**运行时**，不写入设置 JSON。
- `quota.reset_at`：**来源仅为网关响应头 `X-Quota-Reset-At`**（网关按北京时间 00:00 判定）；客户端只展示，不按本地时区自行推算/倒计时到本地零点；离线时展示上次已知值并把 `network` 标为 `unknown`（P1-05）。

### 1.5 其他

| 类型 | 用途 |
|---|---|
| `CaptureSession` | `{capture_id, mode:"voice"|"text", started_at, max_duration_ms}` |
| `WidgetState` | `{visible, geometry:{x,y,width,height,monitor_id|null}, opacity, material_preference, material_effective, always_on_top, scale_factor}` |
| `AppError` | `{code, message, retryable, retry_after_ms|null, trace_id, detail|null}`（§2.4） |

---

## 2. 错误信封

### 2.1 形状

```json
{
  "code": "CLR-E3005",
  "message": "转写服务暂时不可用，可直接打字",
  "retryable": true,
  "retry_after_ms": 300,
  "trace_id": "trace_01J9Z2M4Q8Y6T1V3W5X7Y9Z1B6",
  "detail": null
}
```

- `message`：**中文、面向用户、可直接展示**；完整文案清单见 `error-taxonomy.md`。
- `retryable`：前端是否可自动重试（结合命令类别，见 §8）。
- `detail`：v1 恒为 null；技术细节只进本地日志（`trace_id` 关联）。
- 前端 `ipc.ts` 统一抛出带 `code` 的 `IpcError`，UI 层按 code 决定展示与降级，不得解析 `message` 做逻辑判断。

### 2.2 通用错误（所有命令可能返回）

`CLR-E0001`（内部错误）、`CLR-E5002`（写库失败）、`CLR-E5004`（数据库忙）、`CLR-E6005`（窗口操作失败）、`CLR-E0001`（越权调用）。

---

## 3. 命令总表

| 分组 | 逻辑名 | 导出命令 | 幂等 | 能力 | 说明 |
|---|---|---|---|---|---|
| 捕捉 | `capture.start` | `capture_start` | 否 | main | 开始一次捕捉会话（语音/文字） |
| | `capture.stop` | `capture_stop` | 否 | main | 停止录音并产出内存音频句柄 |
| | `capture.cancel` | `capture_cancel` | 是 | main | 取消并释放缓冲 |
| AI | `ai.transcribe` | `ai_transcribe` | 否 | main | 转写（消费音频句柄） |
| | `ai.parse` | `ai_parse` | 是（按 capture_id） | main | 解析并**落库**创建事项 |
| 事件 | `event.create` | `event_create` | `op_id` | main | 受控创建（测试/恢复；主链路不走） |
| | `event.get` | `event_get` | 是 | main | 详情抽屉 |
| | `event.update` | `event_update` | `op_id` | main | 编辑（未完成项） |
| | `event.delete` | `event_delete` | `op_id` | main | 永久删除 |
| | `event.complete` | `event_complete` | `op_id` | main / widget | 完成（单次/无时间/周期本次） |
| | `event.restore` | `event_restore` | `op_id` | main | 恢复（≤24 h / 本周期计数） |
| | `event.increment_count` | `event_increment_count` | `op_id` | main / widget | 计数 +1（**不封顶**；无完成态、无折叠） |
| 视图 | `view.query` | `view_query` | 是 | main / widget | §1.3 |
| 设置 | `settings.get` | `settings_get` | 是 | main | |
| | `settings.update` | `settings_update` | 否 | main | 深合并 patch + 校验 + 应用副作用 |
| | `settings.reset` | `settings_reset` | 否 | main | 恢复默认（不涉及凭据） |
| 凭据 | `credentials.set` | `credentials_set` | 否 | main | 明文只进不出（单向） |
| | `credentials.delete` | `credentials_delete` | 是 | main | |
| | `credentials.status` | `credentials_status` | 是 | main | 只返回 configured + 掩码 |
| | `credentials.test` | `credentials_test` | 否 | main | 测试连通（官方 health / BYOK 轻请求） |
| 状态 | `service.status` | `service_status` | 是 | main / widget | §1.4 |
| | `quota.refresh` | `quota_refresh` | 是 | main / widget | 主动探测（health 带鉴权） |
| 维护（仅 debug） | `maintenance.run` | `maintenance_run` | 是 | main（仅 debug 构建注册） | 测试/联调：注入 now 触发一轮 24 h 清理 + 计数周期重置（§4.18） |
| 窗口 | `window.show_main` | `window_show_main` | 是 | main / widget | 参数 `page: "main"\|"settings"` |
| | `window.hide_main` | `window_hide_main` | 是 | main | |
| | `app.quit` | `app_quit` | 是 | main | 设置页退出入口（无托盘） |
| 悬浮窗 | `widget.show` / `widget.hide` / `widget.toggle` | `widget_show` / `widget_hide` / `widget_toggle` | 是 | main | 快捷键路径也走这里 |
| | `widget.get_state` | `widget_get_state` | 是 | main / widget | §1.5 |
| | `widget.set_geometry` | `widget_set_geometry` | 否 | main | 设置页预览/重置；拖拽缩放由窗口事件自动持久化 |
| | `widget.set_style` | `widget_set_style` | 否 | main | 透明度/材质/置顶 |
| | `widget.reset_geometry` | `widget_reset_geometry` | 是 | main | 回到默认位置/尺寸 |

---

## 4. 命令详情

### 4.1 `capture.start`

```json
{ "mode": "voice", "source": "hotkey" }
```

返回：

```json
{ "capture_id": "cap_01J9Z2M4Q8Y6T1V3W5X7Y9Z1B3", "mode": "voice",
  "started_at": "2026-11-02T09:00:00Z", "max_duration_ms": 15000 }
```

- `source`：`hotkey` \| `main`（用于日志与体验统计，不落库）。
- `mode="text"`：**不打开麦克风**，仅建立会话（用于统一状态机和 `ai_parse` 幂等键）。
- 语音不可用（`ai.mode=rules` 或 ASR 来源为 `unavailable`）→ `CLR-E3008`，前端应改为打开文字捕捉条。

### 4.2 `capture.stop`

```json
{ "capture_id": "cap_01J9..." }
```

返回：

```json
{ "capture_id": "cap_01J9...", "mode": "voice", "audio_ms": 3200, "too_short": false }
```

- 音频（16 kHz 单声道 s16le WAV，≤15 s）保留在 Rust 内存句柄中，**TTL 120 s 或直到下一次捕捉**；不写盘、不回传前端。
- `too_short=true`（<300 ms）或 `audio_ms=0` → 前端提示重说，直接 `capture.cancel`；后端不报错（避免"错误"语气）。
- `mode="text"` 时为 no-op 返回 `{mode:"text", audio_ms:0, too_short:false}`。

### 4.3 `capture.cancel`

```json
{ "capture_id": "cap_01J9..." }
```

返回 `{ "cancelled": true }`；释放音频缓冲并结束会话。重复调用幂等。

### 4.4 `ai.transcribe`

```json
{ "capture_id": "cap_01J9..." }
```

返回：

```json
{ "text": "明天下午三点跟张总开会，顺便买牛奶。", "language": "zh-CN",
  "duration_ms": 3200, "latency_ms": 1180, "source": "official",
  "provider": "aliyun_bailian", "model": "paraformer-realtime-v2" }
```

- 每次播放/转写消费一次音频句柄；重复调用返回 `CLR-E3009`（句柄已消费/过期）。
- `text` 可能为空 → 前端按"没听清"处理，不调用 `ai.parse`。
- 错误：`CLR-E2001/2002/2004/2006/2007/3001/3002/3003/3004/3005/3007/3008`；转写失败详情见 §8。

### 4.5 `ai.parse`

```json
{ "text": "明天下午三点跟张总开会，顺便买牛奶", "source": "voice",
  "capture_id": "cap_01J9...", "now": null, "timezone": null }
```

- `text`：1–1000 字符（ai-json §2.1；前端/后端双重校验）。
- `now`/`timezone`：默认取系统；仅测试/联调可显式传入（v1 前端不传）。

返回（**已落库**，事务内 1–5 条）：

```jsonc
{
  "batch_id": "cap_01J9Z2M4Q8Y6T1V3W5X7Y9Z1B3",
  "events": [ /* Event[]，按创建顺序，最多 5 条 */ ],
  "mode_used": "official",
  "degraded": false,
  "degraded_reason": null,
  "timings": { "transcribe_ms": null, "parse_ms": 1430, "total_ms": 1520 }
}
```

- 同一 `capture_id` 重复调用：返回首次创建的事件（不再调用 AI、不重复创建）。
- `batch_id` 与捕捉会话的 `capture_id` **同值映射**：客户端把 `capture_id` 作为网关 HTTP 信封的 `batch_id` 发送（仅网关配额去重/分组用，不落库，见 `03-domain-model.md` §1.1、gateway-api §1/§4）。
- `degraded=true` 且 `mode_used="rules"` 时，前端轻提示"已用本地规则安排"（不阻塞、不弹窗）。
- 事件创建后由后端逐个 `emit("event.created", {event})`；前端收到后刷新当前视图。
- 错误：`CLR-E4001/4002/4003/4004/4005/4006/5002`；解析失败仍会走规则兜底（`degraded`），只有"输入非法/库失败/无法兜底"才抛错。

### 4.6 `event.create`（受控）

```json
{ "title": "买牛奶", "source": "manual", "op_id": "…" }
```

可选字段：`due_date|due_start_at|due_end_at|deadline_at|repeat_freq|repeat_interval|repeat_weekdays|count_target|count_period`。
返回 `Event`；不合法组合 → `CLR-E5006`（domain §13）。能力：仅 `main`；v1 主链路使用 `ai.parse`，本命令供测试/故障恢复。

### 4.7 `event.get`

`{ "event_id": "..." }` → `Event`；不存在 → `CLR-E5005`。

### 4.8 `event.update`

```json
{
  "event_id": "0198...",
  "patch": { "title": "跟张总开会", "due_start_at": "2026-11-03T07:00:00Z" },
  "op_id": "…"
}
```

- `patch` 只含要改的字段；显式 `null` = 清空（如 `"repeat_freq": null`）；缺失 = 不变。
- 校验：domain §10.2/§13；已完成项不可编辑（`CLR-E5007`）。
- 返回更新后的 `Event`；并发写用条件 UPDATE，失败返回 `CLR-E5004`（前端提示重试）。

### 4.9 `event.delete`

`{ "event_id": "...", "op_id": "..." }` → `{ "deleted": true, "event_id": "..." }`

- 普通型：物理删除整行；周期型：删"本次"并推进（domain T5），返回 `{"deleted": true, "advanced": true, "event": Event}`。
- 已完成项不提供删除（前端隐藏入口；后端 `CLR-E5007`）。

### 4.10 `event.complete`

```json
{ "event_id": "0198...", "op_id": "…" }
```

返回：

```jsonc
{ "event": { /* 更新后 */ }, "completion": { /* OccurrenceCompleted | null */ },
  "just_completed": true }
```

- 单次/无时间型：写 `completed_at`（重复点击幂等，不覆盖原值）。
- 周期型：写完成日志 + 事件推进到下一次；`completion` 返回日志，`event` 是推进后的事件。
- 计数型：**不允许**用本命令（用 `event.increment_count`）→ `CLR-E5006`。
- 成功后 `emit("event.completed")`；前端 1 s 内从悬浮窗移除（乐观隐藏 + 事件确认）。

### 4.11 `event.restore`

```json
{ "event_id": "0198...", "completion_id": "comp_01J9...", "op_id": "…" }
```

- 单次/无时间型：`completion_id` 省略；`completed_at=NULL`。
- 周期型：`completion_id` 必填且必须是该事件**最新**日志，否则 `CLR-E5009`；超 24 h/已清理 → `CLR-E5008`。
- 计数型：**不适用恢复**（计数无完成态、不产生折叠）；调用返回 `CLR-E5006`，UI 不提供入口。
- 返回更新后的 `Event`（周期型另回恢复的 occurrence 字段）。

### 4.12 `event.increment_count`

`{ "event_id": "...", "op_id": "…" }`（固定 +1；不接受 `delta`）

返回：

```jsonc
{ "event": { /* 更新后 */ }, "progress": 4, "target": 3, "period_key": "2026-11-02" }
```

- **不封顶**：`count_progress+1`，**允许超过 `count_target`**（如 4/3）；目标只用于显示参照。
- **无完成态**：不写 `completed_at`、不产生完成日志、不进"已完成"折叠、**不返回任何"已完成"字段**（无 `just_completed`）；UI 只显示 `progress/target · 周期`。
- 周期边界（`count_period=day` → 本地零点；`week` → 本地周一 00:00，经 Clock）：`count_progress=0`、`count_period_key=当前键`；**无 24 h 删除**（事件行保留）。
- 跨周期旧数据：后端先按当前周期键复位再 +1（domain §8）；`period_key` 返回当前键。
- `op_id` 去重防止双击 +2（本命令最需要幂等）。

### 4.13 `view.query`

请求/返回见 §1.3。错误仅通用错误（本地 DB）。

### 4.14 `settings.get` / `settings.update` / `settings.reset`

- `settings.get`：`{}` → **Settings**（结构见 `05-contracts/config-schema.md`；不含任何密钥明文）。
- `settings.update`：`{ "patch": {...}, "op_id"? }` → Settings。
  - 深合并 patch（对象递归、数组整体替换、`null` 表示恢复该项默认值）；
  - 校验失败 → `CLR-E1006`（返回首个非法字段路径的**通用中文提示**，不返回内部路径细节）；
  - 写盘失败 → `CLR-E1008`；成功后 `emit("settings.changed")`，并应用副作用：重注册快捷键、应用悬浮窗样式、刷新视图。
- `settings.reset`：`{ "section": "all"|"views"|"widget"|"shortcuts"|"ai" }` → Settings；**不删除凭据**（凭据需 `credentials.delete`）。

### 4.15 `credentials.set` / `delete` / `status` / `test`

```json
{ "kind": "activation_code", "secret": "CLR-XXXX-XXXX-XXXX" }
```

- `kind`：`activation_code` \| `byok_parse_key` \| `byok_asr_key`。
- `credentials.set`：单向写入 Windows 凭据管理器；**返回值只有** `{ "configured": true, "hint": "CLR-****-7F3A" }`；明文永不回传、不落日志。
- `credentials.delete`：`{kind}` → `{configured:false}`。
- `credentials.status` → `{activation_code:{configured,hint}, byok_parse_key:{configured,hint}, byok_asr_key:{configured,hint}}`。
- `credentials.test`：`{kind}` → `{ok:true, latency_ms, upstream:"official_gateway"|"deepseek"|"aliyun_asr", message?}`；失败走 `CLR-E1002/1003/1004/1007/2001/2002`。

### 4.16 `service.status` / `quota.refresh`

- `service.status`：`{}` → `ServiceStatus`（读本地缓存 + 最近一次网关响应头；不主动联网）。
- `quota.refresh`：`{}` → `ServiceStatus`；官方已配置时调用 `GET /v1/health`（带鉴权，零成本），更新配额/预算并 `emit("quota.updated")`。
- 频率限制：前端 `quota.refresh` 最短间隔 30 s（后端节流，超频返回上次结果，不报错）。
- 额度重置时间只取网关响应头 `X-Quota-Reset-At`（网关按北京时间 00:00 判定，权威）；客户端不按本地时区推算；刷新失败时保留上次值并把 `network` 置 `unknown`（P1-05）。

### 4.17 窗口/悬浮窗命令

- `window.show_main`：`{page:"main"|"settings"}` → `{visible:true}`；同时聚焦（用户主动操作，允许抢焦点）。
- `window.hide_main` → `{visible:false}`。
- `app.quit` → 无返回（进程退出前 flush 日志；不写"用户选择退出"到设置）。
- `widget.show/hide/toggle` → `WidgetState`；快捷键路径由 Rust 直接调用同一实现。
- `widget.get_state` → `WidgetState`（`material_effective` 为运行时实际生效值，可能因降级不同于 preference）。
- `widget.set_geometry`：`{x,y,width,height,monitor_id?}` → `WidgetState`；越界自动夹到工作区（domain 无规则，见 config-schema §7）；宽高夹在 `[260×140, 480×720]`（占位默认，待视觉细化）。
- `widget.set_style`：`{opacity?, material?, reduced_transparency?}` → `WidgetState`；透明度取值 `0.75/0.9/1.0`（档位，见 config-schema §4.3）；`material` 为 `auto|acrylic|mica|solid`；材质不可用 → 自动降级并在 `material_effective` 反映（不报错，`notice` 提示一次）。置顶为产品硬要求，v1 恒为 true，不开放修改。
- `widget.reset_geometry` → `WidgetState`（主屏工作区右下角，24 px 边距；待视觉细化）。

### 4.18 `maintenance.run`（测试维护命令，仅 debug 构建注册）

```json
{ "now_override": "2026-11-03T09:00:00+08:00" }
```

- 用途：测试/本地联调**手动触发一轮维护**——24 h 物理清理 + 计数周期重置 + 维护时间戳，用于验证 24 h 边界、跨日/跨周，**不需要真实等待**（配合 `04-architecture.md` §3.5 的 `FakeClock`；对应 `07-test-strategy.md` §3.4 TQ-1/TQ-2）。
- **仅 debug 构建注册**：release 构建不注册该命令（调用表现为未知命令）；能力白名单仅 `main`（widget 不可调用）。
- `now_override`：可选，RFC3339 带偏移；缺省使用注入 `Clock.now_utc()`；仅此调试入口接受外部 now（生产逻辑不接受覆盖）。
- 返回：`{ "ran_at": "2026-11-03T01:00:00Z", "purged_events": 2, "purged_completions": 3, "count_reset": 1 }`；幂等，可重复调用。
- 错误：通用错误（`CLR-E5002` 等）；release 下命令不存在，前端不得依赖。
- 与生产路径关系：生产由启动、每 60 分钟、系统唤醒自动执行**同一实现**；`maintenance.run` 只是手动入口，不在 UI 暴露。

---

## 5. 事件推送

统一由 Rust `emit`，payload 均为对象，携带 `at`（UTC ISO）与 `revision`（进程内单调递增，便于前端丢弃乱序）。

| 事件 | payload | 时机 | 消费方 |
|---|---|---|---|
| `event.created` | `{event, at, revision}` | 事项创建（含 `ai.parse` 批量） | main、widget（widget 刷新今日） |
| `event.updated` | `{event, changes: string[], at, revision}` | 编辑/完成日志推进/计数 +1（changes 含 `count_progress`；**计数不发 `event.completed`**）/恢复 | main、widget |
| `event.deleted` | `{event_id, deleted_kind:"event"|"occurrence", at, revision}` | 物理删除/周期删本次 | main、widget |
| `event.completed` | `{event, completion: OccurrenceCompleted|null, at, revision}` | `event.complete` 成功（**计数型不产生**，计数 +1 只发 `event.updated`） | main、widget |
| `event.restored` | `{event, completion_id: string|null, at, revision}` | `event.restore` 成功 | main |
| `event.purged` | `{event_ids: string[], completion_ids: string[], at, revision}` | 24 h 清理物理删除后 | main（从折叠区移除） |
| `capture.level` | `{capture_id, level: 0-100}` | 录音中 20 Hz（前端可订阅/退订） | main |
| `capture.auto_stop` | `{capture_id, reason:"silence"|"max_duration"}` | VAD 静音断句或 15 s 上限 | main |
| `ai.status` | `{stage:"transcribe"|"parse", state:"started"|"succeeded"|"failed"|"degraded", mode, latency_ms?, error_code?}` | AI 阶段开始/结束（用于"正在理解"流光与降级提示） | main |
| `quota.updated` | `{quota, budget, at}` | 每次 AI 响应头更新 / `quota.refresh` | main、widget |
| `settings.changed` | `{settings, changed_keys: string[]}` | `settings.update/reset` 成功 | main、widget（widget 只关心样式/范围相关 key） |
| `widget.geometry_changed` | `{geometry, at}` | 用户拖拽/缩放结束（500 ms 防抖） | main（设置页预览同步） |
| `app.error` | `{code, message, source:"startup"|"scheduler"|"window"|"shortcut", at}` | 后台错误（启动降级、热键冲突、清理失败等） | main（设置页错误区/轻提示） |

事件与命令的时序：命令**先落库成功，再发事件**；前端收到事件后以事件数据为最新（不做"事件回写命令返回值"的反向覆盖）。

---

## 6. 命令级错误码映射

| 命令 | 常见错误码 | 前端处理 |
|---|---|---|
| `capture.start` | `CLR-E3001/3008` | 麦克风/语音不可用 → 切文字模式并提示 |
| `capture.stop` | `CLR-E3002/3003/3004` | 设备断开/过短/无声 → 提示重说，取消会话 |
| `ai.transcribe` | `CLR-E2001/2002/2004/2006/2007/3005/3007` | 见 §8 重试与降级；失败转文字编辑 |
| `ai.parse` | `CLR-E4001/4002/4003/4004/4005/5002` | 已含规则兜底；仍失败 → 提示重试并保留文字 |
| `event.*` | `CLR-E5005/5006/5007/5008/5009/5004` | 详情/列表提示；成功后刷新视图 |
| `settings.update` | `CLR-E1006/1008` | 提示"设置未保存"，回滚 UI |
| `credentials.*` | `CLR-E1002/1003/1004/1007` | 设置页提示；不自动重试（除 test） |
| `window/widget.*` | `CLR-E6002/6005` | 轻提示；悬浮窗失败降级为主窗可用 |
| `quota.refresh` | `CLR-E2001/2004` | 保留上次状态，`network="unknown"` |
| `maintenance.run`（仅 debug） | `CLR-E0001/5002` | 仅测试使用；失败写日志，不提示用户 |

完整错误码、中文文案、可重试性与降级动作 → `05-contracts/error-taxonomy.md`。

---

## 7. 前端状态机（捕捉）

```
idle
 ├─(热键/点击)→ starting ──capture_start────► recording
 │                                │  capture.level / auto_stop
 │                                ├─用户停止→ stopping ─capture_stop→ finalizing
 │                                │                          ├─too_short → idle（提示重说）
 │                                │                          └─ok → transcribing
 │                                │                                      │ ai_transcribe
 │                                │                     ┌────────────────┼────────────────┐
 │                                │                     │失败            │成功             │空文本
 │                                │                     ▼                ▼                ▼
 │                                │              text_fallback       parsing          idle("没听清")
 │                                │              (显示可编辑文字)        │ ai_parse
 │                                │                     │                ├─成功 → done（轻提示/降级提示）→ idle
 │                                │                     │                └─失败 → error（保留文字，可重试）→ idle
 └─(Esc/再按热键)→ cancelling ──capture_cancel──► idle
```

- `starting` 超时 500 ms → 报 `CLR-E3001`；`stopping` 超时 800 ms → 报 `CLR-E3004`。
- `transcribing` 客户端超时 8 s、`parsing` 12 s（覆盖网关内部 1 次校验重试）；超时行为见 §8。
- 已入库的创建不可重复（`ai.parse` 幂等）；`text_fallback` 中用户改完文字直接 `ai.parse`（`source="text"`）。
- 前端不得自行调用网关/厂商；AI 调用只经 `ai.*` 命令。

---

## 8. 超时与重试策略

| 类别 | 超时 | 自动重试 | 说明 |
|---|---|---|---|
| 本地读命令（`event.get`/`view.query`/`settings.get`/`service.status`） | 2 s | 1 次（仅 DB busy/传输错误；间隔 100 ms） | 失败展示错误态；不阻塞 |
| 本地写命令（`event.*`/`settings.*`/`widget.*`） | 3 s | 0（依赖 `op_id` 幂等，用户手动重试） | 避免重复写入；UI 回滚乐观状态 |
| `capture.start/stop/cancel` | 500 ms / 800 ms / 500 ms | 0 | 失败提示；不残留会话 |
| `ai.transcribe` | 8 s | 1 次（仅 `E2001/E2002/E2004/E2005`，退避 300 ms） | 401/413/429 不重试；失败转文字编辑 |
| `ai.parse` | 12 s | 1 次（仅 `E2001/E2002` 网络类；解析 JSON/超时由网关内部重试 1 次，客户端不再对 `E4001/E4004` 重试） | 失败后由后端走规则兜底；`E4002/4003` 不重试（避免重复花大模型钱） |
| `credentials.test` | 6 s | 1 次（网络类） | 失败给出可行动文案 |
| `quota.refresh` | 5 s | 0 | 失败保留旧状态 |

重试由后端执行（前端只设超时并等待），避免前端重试与后端重试叠加。转写与解析的重试**各自独立**，合计最多 1+1 次。

---

## 9. 窗口能力（capability）白名单

| 命令/事件 | `main` | `widget` |
|---|---|---|
| `view.query`、`event.complete`、`event.increment_count`、`service.status`、`quota.refresh` | ✅ | ✅ |
| `window.show_main`、`widget.get_state` | ✅ | ✅ |
| `capture.*`、`ai.*`、`event.get/update/delete/create/restore`、`settings.*`、`credentials.*`、`window.hide_main`、`app.quit`、`widget.show/hide/toggle/set_*` | ✅ | ❌ |
| `maintenance.run`（仅 debug 构建注册） | ✅（仅 debug） | ❌ |
| 事件 `event.*`、`quota.updated`、`settings.changed` | ✅ | ✅（widget 仅响应其中样式/视图相关变化） |
| 事件 `capture.*`、`ai.status`、`app.error` | ✅ | ❌ |

- 白名单在 Tauri capabilities 配置中按窗口 label 声明；新增命令必须同时更新本表与 capabilities，否则主窗也不可用。
- `maintenance.run` 在 release 构建**不注册**、capabilities 仅 debug 包声明；测试通过它 + `FakeClock` 演示 24 h 边界（04 §3.5）。
- 悬浮窗的**创建入口**（语音/文字）按 00-decisions §10-11 未定，v1 默认不在 widget 开捕捉；上表随之保持 `capture.*` 不可用（若后续确认，再开放并加录音权限说明）。

---

## 10. 版本与变更流程

- IPC 契约随客户端发版；同仓库前端与 Rust 同 PR 修改，不承诺跨版本兼容。
- 新增命令/字段：向后兼容，更新本文件 + capabilities + 对应测试。
- 改名/删除命令、改变语义：视为破坏性变更，需 ADR 级别的理由 + 本文件版本升级 + PR checklist 勾选。
- 错误码：只增不改；新增须在 `error-taxonomy.md` 登记（禁止复用已废弃码）。
- `settings` 字段变更同步 `config-schema.md`（含迁移规则）；AI 输出字段变更同步 `ai-json.md` 并跑评估集。

---

## 11. 待确认 / 待 spike

| # | 项 | 影响 | 归属 |
|---|---|---|---|
| I1 | 悬浮窗 B 模板"全部"范围与是否包含无时间/完成（widget 能力级） | §1.3 widget 行为细节 | 与 02-ux-spec 对齐后回写 |
| I2 | 主窗 A"一天"是否可翻看非今天的日期 | `timeline_day.date` 使用方式 | UX 决定（契约已支持任意日期） |
| I3 | 悬浮窗创建入口是否开放（00-decisions §10-11） | §9 capability 白名单 | 用户确认后回写 |
| I4 | 时间范围"选区"交互是否允许跨 24:00（如 20:00–02:00） | `time_range` 校验 | 视觉/交互细化后定（config-schema §6） |
| I5 | 流式字幕（`capture.partial`）是否进 v1 | 事件与网关流式形态 | P1；S1 后定 |
| I6 | `event.create` 是否保留为公开命令 | 契约面 | 若恢复路径不需要可降为 internal |
| I7 | 官方/BYOK/规则的降级顺序与"额度尽时语音是否可用"（PRD Q21/Q27） | §1.4 `ServiceStatus` 与 `ai.mode` 语义 | 待产品确认后回写（当前按 04-architecture §5.1 建议实现） |

---

## 12. 变更记录

| 版本 | 日期 | 变更 | 作者 |
|---|---|---|---|
| v0.1 | 2026-11-01 | 首版：公共类型（Event/Occurrence/ViewResult/ServiceStatus）、命令清单与详情、事件推送、错误映射、状态机、重试策略、能力白名单 | tech-writer |
| v0.2 | 2026-11-01 | 红队修复：新增 §4.18 `maintenance.run`（仅 debug、main 白名单，触发 24h 清理/周期重置）；§1.4/§4.16 明确额度重置权威=网关、客户端只展示 `X-Quota-Reset-At`；§4.5 补 `capture_id`↔`batch_id` 映射；§6/§9 同步 | tech-writer |
| v0.3 | 2026-11-01 | 计数语义（用户确认）：命令统一为 `event.increment_count`，+1 不封顶（progress 可 > target，如 4/3）；计数无完成态（不写 completed_at、不进折叠、无 24h 删除、无恢复），仅周期边界复位；`ViewResult.completed` 移除 `counts`；§1.1/§1.3/§4.10/§4.11/§4.12/§5/§9 同步 | tech-writer |
