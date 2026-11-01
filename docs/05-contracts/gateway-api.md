# 官方网关 API 契约（gateway-api）

- Owner：tech-writer（技术与工程文档）
- 版本：v0.2（红队修复稿；v0.1 初稿）
- 更新日期：2026-11-01
- 本次修订（v0.2）：P1-05 额度重置权威=网关北京时间 00:00、客户端只展示 `X-Quota-Reset-At`（§1.2/§6.4）；P1-06 录音上限统一 15 s（§3.1）；P1-09 用量保留期与 11 对齐（§7）；§6.1 补 200 单位口径。修订章节：§1.2、§3.1、§6.1、§6.4、§7、§8、§12。
- 状态：**v1 冻结候选**。部署形态与配额策略见 ADR-0001/0002、`10-risks-decisions.md` D12/D17/D20。
- 相关：`04-architecture.md` §5.6、`05-contracts/tauri-ipc.md`（客户端侧调用与重试）、`05-contracts/ai-json.md`（`actions[]` 与输入字段的唯一事实源）、`03-domain-model.md`（落库字段）、`05-contracts/error-taxonomy.md`（客户端错误码映射）、`docs/ops/official-ai-gateway-setup.md`（部署步骤）

---

## 0. 设计原则

1. **薄**：网关只做五件事——鉴权、配额/预算、转发、校验、用量记账；不存音频、不存正文、不做业务逻辑。
2. **无状态**：没有数据库；用量记录写 OSS；函数实例可随时销毁。**无音频/正文持久化**。
3. **同步短请求**：客户端只调 HTTP；ASR 若只有 WebSocket，由网关内部适配，客户端不感知。
4. **错误可行动**：每个错误码都能让客户端决定"自动重试 / 换模式 / 提示用户"（映射见 §8）。
5. **最小暴露**：返回给客户端的信息只包含结果与用量；内部错误细节只进网关日志（凭 `request_id` 排查）。

Base URL（v1）：阿里云 FC 默认域名，形如 `https://<account-id>.<region>.fcapp.run`，不购买域名、不备案（D17）。客户端默认值在 `05-contracts/config-schema.md` 的 `ai.official.gateway_url` 中给出（非秘密，随安装包分发；发布前填入实际 FC 地址）。

API 版本：路径固定 `/v1`。`/v1` 内**不删字段、不改语义**；破坏性变更新增 `/v2` 且网关同时兼容旧版至 `MIN_APP_VERSION`。

---

## 1. 通用约定

| 项 | 约定 |
|---|---|
| 传输 | HTTPS（TLS 1.2+），HTTP/1.1 或 HTTP/2 |
| 编码 | 文本 UTF-8；JSON `application/json; charset=utf-8`；音频 `audio/wav` |
| 时间 | ISO 8601 带偏移，如 `2026-11-01T16:30:52+08:00` |
| ID | `request_id` 由网关生成（客户端可传 `X-Request-Id` 覆盖），格式 `req_` + 26 位 Crockford Base32；`batch_id`/`capture_id` 由客户端生成（`cap_` + 26 位） |
| 幂等 | 请求本身无缓存无幂等表；配额按 `capture_id` 去重计费（§6.2），重试不会重复扣额度 |
| 响应头 | `Cache-Control: no-store`，`X-Request-Id`，`X-Gateway-Version` |
| 压缩 | 不启用 gzip（音频已压缩过/体积可控；避免解压放大攻击） |
| CORS | 不开启（客户端为桌面原生，不是浏览器） |
| 最大请求体 | 2 MB（FC 触发器与函数内双重校验） |

### 1.1 请求头

| Header | 必填 | 示例 | 说明 |
|---|---|---|---|
| `X-Activation-Code` | 是 | `CLR-XXXX-XXXX-XXXX` | 激活码（**示例为占位格式，真实码绝不写入仓库/文档**）；官方模式鉴权 |
| `X-Device-Id` | 是 | `4b1c2f7e-0a3d-4f6b-9c8e-1f2a3b4c5d6e` | 客户端首次运行生成的随机 UUID v4；仅用于配额计数，不绑定个人信息 |
| `X-App-Version` | 是 | `0.1.0` | 语义化版本；用于排查与最低版本门槛 |
| `X-Request-Id` | 否 | `req_01JABCDEF...` | 客户端生成的追踪 ID；缺省由网关生成 |
| `Content-Type` | 按接口 | `audio/wav` / `application/json` | |
| `Content-Length` | 是（POST） | `480044` | |

**安全注意**：`X-Activation-Code` 每次请求经 TLS 传输；网关只做 HMAC 常量时间比对，**日志只允许记录 8 位哈希前缀**（§7）。

### 1.2 响应头（配额/预算，所有已通过鉴权的响应都带）

| Header | 示例 | 说明 |
|---|---|---|
| `X-Quota-Limit` | `200` | 每设备每日额度（单位见 §6.1） |
| `X-Quota-Used` | `37` | 本设备今日已用 |
| `X-Quota-Remaining` | `163` | 剩余 |
| `X-Quota-Reset-At` | `2026-11-02T00:00:00+08:00` | 额度重置时间（**网关按北京时间 00:00 判定**；客户端只展示、不自行推算，P1-05） |
| `X-Budget-State` | `ok` \| `warn` \| `exhausted` | 月预算状态；`warn` = ≥80%，`exhausted` = ≥100% |
| `X-Budget-Used-Cny` | `36.42` | 当月已用（估算，两位小数） |
| `X-Budget-Limit-Cny` | `200.00` | 当月预算 |
| `Retry-After` | `24500` | 仅 429 时返回，单位秒（到额度重置或预算恢复） |

未通过鉴权（401）时**不返回**配额头（避免泄露额度状态）；可返回 `X-Request-Id`。

---

## 2. `GET /v1/health`

用途：客户端"测试连接"、配额刷新、服务状态展示。**不调用任何上游**（零成本，可频繁调用）。

### 2.1 请求

**无鉴权（存活探测）**：

```http
GET /v1/health HTTP/1.1
Host: <fc-default-domain>
Accept: application/json
```

**带鉴权（客户端使用，返回额度）**：附带 `X-Activation-Code`、`X-Device-Id`、`X-App-Version`。

### 2.2 响应 200

无鉴权：

```json
{
  "status": "ok",
  "service": "clarify-gateway",
  "version": "2026.11.1",
  "time": "2026-11-01T16:30:52+08:00",
  "region": "cn-hangzhou"
}
```

带鉴权（追加 `auth`/`quota`/`budget`）：

```json
{
  "status": "ok",
  "service": "clarify-gateway",
  "version": "2026.11.1",
  "time": "2026-11-01T16:30:52+08:00",
  "region": "cn-hangzhou",
  "auth": { "activation": "active" },
  "quota": { "limit": 200, "used": 37, "remaining": 163, "reset_at": "2026-11-02T00:00:00+08:00" },
  "budget": { "state": "ok", "used_cny": 36.42, "limit_cny": 200.0 }
}
```

### 2.3 错误

`401 ACTIVATION_INVALID / ACTIVATION_REVOKED / ACTIVATION_MISSING`（带鉴权时）；`400 INVALID_REQUEST`（device id 格式错）。无鉴权探测不受配额影响。

---

## 3. `POST /v1/transcribe`（语音转写）

服务端职责：校验请求 → 校验配额 → 调 ASR 供应商（spike S1 决定，默认候选阿里云百炼 `paraformer-realtime-v2`；若只有 WS 由网关内部适配）→ 返回最终文本。**音频只在函数内存中处理，转发后即丢弃，不落盘、不记日志。**

### 3.1 请求

```http
POST /v1/transcribe HTTP/1.1
Host: <fc-default-domain>
X-Activation-Code: CLR-XXXX-XXXX-XXXX
X-Device-Id: 4b1c2f7e-0a3d-4f6b-9c8e-1f2a3b4c5d6e
X-App-Version: 0.1.0
X-Request-Id: req_01J9Z2M4Q8Y6T1V3W5X7Y9Z1B3
Content-Type: audio/wav
Content-Length: 480044

<RIFF....WAVE fmt ... data ...>   ← 原始二进制
```

音频约束（客户端与网关双重校验）：

| 项 | 约束 | 违规响应 |
|---|---|---|
| 容器 | RIFF/WAVE，PCM s16le | `400 AUDIO_INVALID_FORMAT` |
| 采样率/声道 | 16 000 Hz / 单声道 | `400 AUDIO_INVALID_FORMAT` |
| 时长 | 0.3 s ≤ d ≤ **15 s**（客户端与网关**同一上限**，P1-06） | `400 AUDIO_INVALID_FORMAT` |
| 体积 | ≤ 2 MB（15 s 16 kHz 单声道 s16le ≈ 480 KB，余量充足） | `413 AUDIO_TOO_LARGE` |
| 内容 | 语种 v1 固定中文（可中英混说） | 无语言参数 |

### 3.2 响应 200

```json
{
  "request_id": "req_01J9Z2M4Q8Y6T1V3W5X7Y9Z1B3",
  "text": "明天下午三点跟张总开会，顺便买牛奶。",
  "language": "zh-CN",
  "duration_ms": 3200,
  "provider": "aliyun_bailian",
  "model": "paraformer-realtime-v2",
  "latency_ms": 1180,
  "usage": { "audio_ms": 3200 }
}
```

- `text` 允许是空字符串（全静音/没听清）：客户端按"没听清"处理（`CLR-E3006`），**不是网关错误**。
- `latency_ms` = 网关内部上游耗时（不含客户端网络）；客户端展示/日志用，不承诺。

### 3.3 错误

`401 / 413 / 429 / 500 / 502 / 504`，格式见 §5。

---

## 4. `POST /v1/parse`（文本解析）

服务端职责：校验 → 配额 → 调 DeepSeek `deepseek-flash`（非思考模式 + JSON Output）→ 结构/语义校验（失败重试 1 次，见 ai-json §7）→ 返回 `actions[]`。**不记录 `transcript` 与模型输出正文。**

### 4.1 请求

```http
POST /v1/parse HTTP/1.1
Host: <fc-default-domain>
X-Activation-Code: CLR-XXXX-XXXX-XXXX
X-Device-Id: 4b1c2f7e-0a3d-4f6b-9c8e-1f2a3b4c5d6e
X-App-Version: 0.1.0
Content-Type: application/json; charset=utf-8

{
  "batch_id": "cap_01J9Z2M4Q8Y6T1V3W5X7Y9Z1B3",
  "transcript": "明天下午三点跟张总开会，顺便买牛奶",
  "now": "2026-11-01T16:30:52+08:00",
  "timezone": "Asia/Shanghai"
}
```

| 字段 | 必填 | 约束 | 说明 |
|---|---|---|---|
| `batch_id` | 是 | `cap_` + 26 位 | 客户端生成；用于配额去重（§6.2）与分组；不进模型输入 |
| `transcript` | 是 | 1–1000 字符 | 转写文本或用户键入文本（ai-json §2.1）；超长 `413 TEXT_TOO_LARGE` |
| `now` | 是 | RFC3339 带偏移 | 客户端本地当前时间；相对时间解析依据（"明天/下周三"） |
| `timezone` | 是 | IANA 时区名 | 如 `Asia/Shanghai` |

- `transcript`/`now`/`timezone` 即 `05-contracts/ai-json.md` §2 的输入契约，网关只额外加 `batch_id` 信封字段；**不得**增补用户偏好、历史事项、标签等（产品已砍：没说就是没有，见 00-decisions §3）。
- 服务端**不接收**任何用户偏好默认值（"明天=几点"这类默认规则已砍）。

### 4.2 响应 200

```json
{
  "request_id": "req_01J9Z2M4Q8Y6T1V3W5X7Y9Z1B4",
  "batch_id": "cap_01J9Z2M4Q8Y6T1V3W5X7Y9Z1B3",
  "model": "deepseek-flash",
  "thinking": "disabled",
  "degraded": false,
  "latency_ms": 1430,
  "version": "1.0",
  "actions": [
    {
      "title": "跟张总开会",
      "time": { "kind": "datetime", "start": "2026-11-02T15:00:00+08:00" },
      "repeat": null,
      "count": null
    },
    {
      "title": "买牛奶",
      "time": { "kind": "none" },
      "repeat": null,
      "count": null
    }
  ],
  "usage": { "prompt_tokens": 312, "completion_tokens": 88 }
}
```

- `version`/`actions[]` 的字段、语义与提取规则**唯一事实源是 `05-contracts/ai-json.md` §3**；本文件只定义 HTTP 信封。网关负责：`actions` 为数组、1–5 条、四键齐全（无则 null）、Schema + 语义校验（ai-json §4.1）；不合格重试 1 次后返回 `502 UPSTREAM_INVALID_JSON`。
- 模型输出**不包含** `confidence`/`source_span`/`assumptions`/`batch_id`（产品无置信度 UI、原文不落库）；`batch_id` 是 HTTP 信封字段，由网关原样回显。
- `degraded` 保留字段：v1 网关固定 `false`（网关不做规则模式；规则在客户端）。
- `thinking` 固定 `"disabled"`（非思考模式），防止模型漂移；`model` 固定 `deepseek-flash`。

### 4.3 错误

`400 / 401 / 413 / 429 / 500 / 502 / 504`，格式见 §5。

---

## 5. 统一错误格式与错误码

### 5.1 错误响应体

```json
{
  "request_id": "req_01J9Z2M4Q8Y6T1V3W5X7Y9Z1B5",
  "error": {
    "code": "QUOTA_DAILY_EXCEEDED",
    "message": "今日 AI 额度已用完",
    "retryable": false,
    "retry_after_s": 24500,
    "detail": null
  }
}
```

- `message`：**中文、面向用户、可直接展示**（客户端也可映射为更完整的文案）。
- `retryable`：网关对"整链重试是否有意义"的判断（客户端仍有自己的策略，见 §8）。
- `detail`：v1 恒为 `null`（不向客户端暴露上游错误细节，避免信息泄露；排查用 `request_id` 查网关日志）。
- 错误响应同样带 §1.2 的配额头（若已通过鉴权）。

### 5.2 错误码总表

| HTTP | `code` | 含义 | `retryable` | 客户端应有行为（详见 error-taxonomy） |
|---|---|---|---|---|
| 400 | `INVALID_REQUEST` | 请求体/头缺失或格式错 | false | 修 bug；提示重试（不应发生） |
| 400 | `MISSING_DEVICE_ID` | 缺 `X-Device-Id` 或不是 UUID | false | 重新生成设备 ID 后重试一次 |
| 400 | `AUDIO_INVALID_FORMAT` | 非 WAV/16k/单声道/时长越界 | false | 客户端侧前置校验，不应发生 |
| 400 | `APP_VERSION_UNSUPPORTED` | 低于 `MIN_APP_VERSION` | false | 提示升级客户端 |
| 401 | `ACTIVATION_MISSING` | 未带激活码 | false | 引导到设置填写 |
| 401 | `ACTIVATION_INVALID` | 激活码不存在/哈希不匹配 | false | 引导到设置更新/联系作者 |
| 401 | `ACTIVATION_REVOKED` | 激活码已吊销 | false | 提示已停用；降级规则/BYOK |
| 413 | `AUDIO_TOO_LARGE` | 音频 > 2 MB | false | 不应发生（录音≤15 s），提示重说 |
| 413 | `TEXT_TOO_LARGE` | transcript > 1000 字符（ai-json §2.1） | false | 提示拆分输入 |
| 429 | `QUOTA_DAILY_EXCEEDED` | 本设备今日 200 单位用完 | false（按日） | 当日停止官方调用；规则/BYOK 降级 |
| 429 | `BUDGET_EXHAUSTED` | 月预算 ¥200 已用尽，官方服务暂停 | false（按月） | 提示服务暂停；规则/BYOK 降级 |
| 500 | `INTERNAL_ERROR` | 网关内部错误 | true（限 1 次） | 同 502 处理 |
| 502 | `UPSTREAM_ERROR` | ASR/DeepSeek 返回错误或不可用 | true（限 1 次） | 转写→重试/转文字；解析→规则兜底 |
| 502 | `UPSTREAM_INVALID_JSON` | 解析输出结构校验失败（已重试 1 次） | false | 规则兜底（不重复加大模型成本） |
| 503 | `SERVICE_UNAVAILABLE` | 网关维护/未配置上游 | true（退避） | 规则/BYOK 降级 |
| 504 | `UPSTREAM_TIMEOUT` | 上游超时（转写 5 s；解析单次 5 s、总预算 ≤11 s） | true（限 1 次） | 转写→重试/转文字；解析→规则兜底 |

> 错误码是**契约**：新增/改语义需同步 `error-taxonomy.md` 与客户端映射表，并更新本文件版本记录。

---

## 6. 配额与预算算法

### 6.1 单位

- **额度单位 = 一次捕捉**：同一 `batch_id` 的 `/v1/transcribe` + `/v1/parse` 合并计 **1 单位**；纯文字创建的 `/v1/parse` 计 1 单位。缺少 `batch_id` 的请求（直连调试）每请求计 1 单位。
- 上限：**每设备 200 单位/自然日**（北京时间 UTC+8 00:00 重置）；≈ 每天 200 次语音捕捉。PRD F11 写的"200 次调用"按此口径 = 200 单位（1 单位 = 1 次捕捉，转写+解析合并计 1；P2-03 用词统一）。
- 计数对象：`device_hash = HMAC-SHA256(GATEWAY_SECRET, device_id)` 取前 16 位 Base32；不存原始 device id。
- 只有**实际转发到上游**的请求计入（401/400/413 不计；上游失败的 5xx **计**，防止失败重试绕过额度）；同一 `batch_id` 的重试不计第二次。

### 6.2 去重与计数流程

```
每次 AI 请求（鉴权通过后）：
  1) 读取今日该 device 的 usage 对象列表（OSS 前缀 usage/dt=YYYY-MM-DD/device=<hash>/）
     → 内存/实例缓存 1 s；计已用单位（同一 batch_id 只算一次）
  2) 若 used >= 200 → 429 QUOTA_DAILY_EXCEEDED（带 reset_at / Retry-After）
  3) 若 budget.state == exhausted → 429 BUDGET_EXHAUSTED
  4) 转发上游
  5) 写用量对象 usage/dt=.../device=<hash>/<batch_id>.json（幂等：object key 含 batch_id）
     {request_id, ts, route, status, error_code,
      batch_id, device_hash, app_version,
      audio_ms?, prompt_tokens?, completion_tokens?,
      cost_cny_est, latency_ms}
  6) 更新月预算聚合（§6.4）
  7) 响应（带配额/预算头）
```

- **原子性**：OSS 无原子计数，采用"对象即计数 + 前缀枚举"；同一设备并发请求可能**短暂超发数条**（内测规模可接受）。100% 预算停止与厂商侧预算告警作为硬兜底。若精度不达标 → 评估 TableStore/Tair 计数器（需新增 ADR，Spike S2 决定）。
- 计数性能：单设备单日 ≤200 对象，`ListObjectsV2` 一次（MaxKeys=1000）可覆盖；1 s 实例缓存降低开销。冷启动时枚举一次。
- 对象生命周期：OSS 生命周期规则 **180 天自动删除**（用量记录）。

### 6.3 月预算（¥200 告警/停止）

- 每次请求估算成本（写入用量对象）：
  - 转写：`audio_ms / 1000 × PRICE_ASR_CNY_PER_SEC`（默认 `0.00024`，按最终选定供应商现价配置）；
  - 解析：`prompt_tokens/1e6 × PRICE_PARSE_IN_CNY_PER_M + completion_tokens/1e6 × PRICE_PARSE_OUT_CNY_PER_M`（按 DeepSeek 现价配置，环境变量可改）。
- 月聚合：`budget/dt=YYYY-MM/agg.json`，每次请求读-改-写（OSS `If-Match` ETag 条件写，冲突重试 2 次）；失败只记日志，不阻塞响应（预算精度为"近似"）。
- 阈值：`used/limit ≥ 0.8` → `X-Budget-State: warn`（客户端提示"接近本月额度"）；`≥ 1.0` → `exhausted`，官方接口一律 429 `BUDGET_EXHAUSTED`，**客户端自动降级规则/BYOK**。
- 独立兜底：阿里云费用中心/百炼/DeepSeek 控制台的**预算与告警**必须同时设置（作者账号级，R4/R9 缓解）。
- 预算告警触达作者：FC 定时触发器（每 10 min）重算当月聚合；≥80% 时写日志并使用阿里云监控/邮件告警（配置在云控制台，不写代码）。**不向客户端推送作者侧告警**（客户端只看到 `warn/exhausted` 状态）。

### 6.4 日重置

`X-Quota-Reset-At` = 下一个北京时间 00:00（带 +08:00 偏移）。42000 秒窗口内 `Retry-After = reset_at - now`。

- **重置权威时钟是网关（北京时区 UTC+8 的 00:00）**，不以客户端时区/本地日期为准（防止改时区刷额度）；测试用可注入时钟验证跨天（`07-test-strategy.md` GW-005）。
- **客户端契约**：只展示本响应头 / `ServiceStatus.quota.reset_at` 的值，不按本地时区自行推算重置时间或倒计时到本地零点（P1-05；tauri-ipc §1.4/§4.16）。

---

## 7. 日志与用量记录规则（隐私红线）

| 允许记录 | 禁止记录 |
|---|---|
| `request_id`、路由、HTTP 状态、错误码、耗时 | 音频字节、音频文件、音频 URL |
| `device_hash`（16 位）、激活码 HMAC 前 8 位 | 原始 `X-Device-Id`、原始激活码 |
| `batch_id`（客户端生成，无用户信息） | `transcript` 原文、模型输出原文 |
| `audio_ms`、token 数、估算成本 | 任何请求/响应 body |
| `app_version`、region、cold_start 标记 | 用户任务标题、任何可识别个人信息 |

实现要求：

1. 代码中禁止打印 `req.headers` / `req.body`；日志函数只接受白名单字段。
2. FC 访问日志：不把敏感信息放 URL/query（本 API 不用 query 传参）；确认 FC 日志不记录请求体（默认不记录，部署时复核）。
3. 错误排查仅凭 `request_id` 关联日志字段；**不保留任何可重放内容**。
4. 用量对象写入 OSS 前再过一次白名单序列化（字段固定 JSON Schema）。
5. 保留期（与 `11-release-ops.md` §4.1/§7.1 数据保留矩阵**对齐**，P1-09）：FC 日志 7 天（默认）；**OSS 用量元数据 180 天**；**预算聚合 24 个月**（OSS 生命周期规则配置，部署时核对；缩短需同时改 11 的隐私告知）。
6. 作者本地开发/联调同样遵守（`spike/` 与 `gateway/` 的测试不得使用真实用户音频/正文；测试数据自带假数据）。

---

## 8. 客户端重试与降级约定（供 tauri-ipc.md 引用）

| 场景 | 客户端策略 |
|---|---|
| 网络错误 / DNS / TLS 失败 | 重试 1 次（仅转写/解析各自独立、退避 300 ms）；仍失败 → 降级（转写：转文字；解析：规则） |
| 502 / 503 / 504 / 500 | 客户端重试 1 次；`UPSTREAM_INVALID_JSON` 不重试（网关已内部重试 1 次，见 ai-json §7）；仍失败 → 转写提示转文字、解析走规则兜底 |
| 解析超时（`UPSTREAM_TIMEOUT`，网关已重试过） | 不再重试，直接规则兜底（避免两段重试叠加拖长等待） |
| 401（`*ACTIVATION*`） | **不重试**；停止官方调用；BYOK 已配置则本次自动切 BYOK；解析最后规则兜底 |
| 413（音频/文本） | **不重试**；客户端前置校验保证正常不触发；音频提示重说、文本提示拆分 |
| 429 `QUOTA_DAILY_EXCEEDED` | **不重试**；当日官方停用；规则/BYOK 兜底；下次 00:00 自动恢复（无需手动操作） |
| 429 `BUDGET_EXHAUSTED` | **不重试**；官方停用至作者调整预算；规则/BYOK 兜底 |
| 400 | 不重试；记 `CLR-E2010`（属 bug，用户提示"刚才没成功，请再试一次"） |
| 超时（客户端转写 8 s / 解析 12 s） | 视为网络失败，重试 1 次 → 降级 |

重试不得叠加（转写与解析各自最多 1 次），避免费用与延迟翻倍；`batch_id` 保证配额不重复计。

---

## 9. 部署形态与运行参数

### 9.1 形态

| 项 | 取值 |
|---|---|
| 平台 | 阿里云函数计算 FC（Serverless） |
| 运行时 | Node.js 20（固定；开发构建用 Node 24，产物为单文件 CJS） |
| 触发器 | HTTP 触发器（默认域名，HTTPS） |
| 函数配置 | 内存 512 MB；函数超时 15 s；上游预算：转写 5 s；解析单次 5 s（ai-json §1）+ 校验失败重试 1 次（退避 500 ms，总预算 ≤11 s）；预留实例 0（内测，冷启动可接受） |
| 部署产物 | `gateway/dist/index.js`（esbuild 打包，仅生产依赖）；无数据库、无容器 |
| 用量存储 | OSS Bucket（私有读写）：`usage/`、`budget/` 前缀；生命周期 180 天 |
| 鉴权白名单 | 激活码 HMAC 列表（环境变量；吊销 = 改配置重新部署，内测可接受） |
| 域名 | FC 默认域名；**不购买域名/不备案**（D17）；公开分发前再评估 |
| 监控 | FC 日志 + 阿里云费用预算告警 + 每日定时汇总（§6.3） |
| 部署方式 | Serverless Devs（`s.yaml`，`pnpm gateway:deploy`）；密钥只在 FC 环境变量/部署 secrets |

### 9.2 环境变量（全部为服务端秘密，**任何真实值不得进仓库**）

| 变量 | 必填 | 说明 |
|---|---|---|
| `ACTIVATION_CODE_HMAC_SECRET` | 是 | 激活码 HMAC 盐；轮换需同时重算白名单 |
| `ACTIVATION_CODE_HASHES` | 是 | 逗号分隔的 HMAC-SHA256(激活码) hex 列表 |
| `DEEPSEEK_API_KEY` | 是 | DeepSeek Key（只存在服务端） |
| `DEEPSEEK_MODEL` | 是 | 固定 `deepseek-flash`；变更需跑 eval 并更新本契约 |
| `DEEPSEEK_BASE_URL` | 否 | 默认 `https://api.deepseek.com` |
| `ASR_PROVIDER` | 是 | `aliyun_bailian`（spike 定稿后填） |
| `ASR_API_KEY` / `ASR_MODEL` / `ASR_REGION` | 是 | 对应供应商凭据与模型（默认候选 `paraformer-realtime-v2`，`cn-beijing`） |
| `OSS_BUCKET` / `OSS_REGION` / `OSS_ENDPOINT` | 是 | 用量记录；建议使用 FC RAM 角色授权，避免静态 AK |
| `QUOTA_DAILY_LIMIT` | 否 | 默认 `200` |
| `MONTHLY_BUDGET_CNY` | 否 | 默认 `200` |
| `BUDGET_WARN_RATIO` | 否 | 默认 `0.8` |
| `PRICE_ASR_CNY_PER_SEC` | 否 | 默认 `0.00024`（按最终供应商现价） |
| `PRICE_PARSE_IN_CNY_PER_M` / `PRICE_PARSE_OUT_CNY_PER_M` | 否 | 按 DeepSeek 现价；用于成本估算 |
| `MIN_APP_VERSION` | 否 | 最低客户端版本；空 = 不限制 |
| `GATEWAY_VERSION` | 否 | 健康检查展示版本 |
| `VERBOSE_LOG` | 否 | **默认 false**；即使开启也禁止记录 body |

### 9.3 启动自检

函数冷启动时校验必填环境变量、OSS 可写、模型名固定；缺失则 `503 SERVICE_UNAVAILABLE`（不泄露具体变量名给客户端，日志中记录）。

### 9.4 契约测试与发布

- 网关不依赖真实厂商即可测：provider 适配层注入 mock（见 `07-test-strategy.md`）；契约测试覆盖全部错误码、配额边界（第 200/201 次）、预算 warn/exhausted、并发去重。
- 发布：`gateway/VERSION` 语义化版本；每次发布更新 `X-Gateway-Version` 与本文件 §变更记录。
- 灰度：内测两台设备先验证；失败回滚上一版本（FC 版本管理）。

---

## 10. 权限与合规备注

- 公开分发前的生成式 AI 合规评估、隐私政策、用户协议延后（ADR-0006、R8）；v1 仅自用 + ≤20 人内测。
- 隐私告知需说明：音频发给 ASR 厂商、文本发给 DeepSeek；网关不保存二者。位置待定（00-decisions §10-17）。
- 激活码/设备 ID 为"服务凭据"，不属于个人身份信息；网关只存哈希。

---

## 11. 待 spike / 待确认

| # | 项 | 影响 | 决策点 |
|---|---|---|---|
| G1 | ASR 供应商与接入形态（S1） | `ASR_*` 变量、`provider` 字段取值、超时预算 | 通过既定规则选定后回写本文件 |
| G2 | 网关冷启动与 10 s 级超时（S2） | 端到端 P95、函数超时配置 | 若冷启动 >1.5 s 影响首次捕捉 → 预留实例/预热（成本权衡） |
| G3 | OSS 计数并发精度（S2） | 额度超发容忍度 | 超发 >5 条/日或需精确 → OTS/Tair（新增 ADR） |
| G4 | FC 环境变量加密/RAM 角色 | 密钥管理 | 部署时确认阿里云当前能力并更新 ops 指南 |
| G5 | DeepSeek 价格随版本变化 | `PRICE_*` 默认值 | 每次厂商调价更新环境变量 + 本文件，无需发客户端 |
| G6 | `batch_id` 由客户端生成的可伪造性 | 配额去重被绕过（同一 batch_id 复用） | 低风险（配额本身按设备）；若发现滥用 → 网关按 batch_id 内容校验/限频 |

---

## 12. 变更记录

| 版本 | 日期 | 变更 | 作者 |
|---|---|---|---|
| v0.1 | 2026-11-01 | 首版：/v1/health、/v1/transcribe、/v1/parse 契约；头/配额/预算/日志/部署/错误码 | tech-writer |
| v0.2 | 2026-11-01 | 红队修复：录音上限统一 15 s（P1-06）；额度重置权威与客户端只展示 `X-Quota-Reset-At`（P1-05）；用量保留期与 11 对齐（180 天/24 个月，P1-09）；200 单位口径补注（P2-03） | tech-writer |
