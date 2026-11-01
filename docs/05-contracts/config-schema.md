# 配置契约（config-schema）

- Owner：tech-writer（技术与工程文档）
- 版本：v0.1（初稿，待评审冻结）
- 更新日期：2026-11-01
- 状态：**v1 冻结候选**。设置结构、默认值、校验、迁移以本文为准；**凭据（激活码/BYOK Key）不在本文 JSON 内**，见 §9。
- 关联：`00-product-decisions.md` §5/§7、`06-adr/0004-data-and-deletion.md`、`06-adr/0006-keys-privacy.md`、`06-adr/0008-visual-naming.md`、`04-architecture.md`、`05-contracts/tauri-ipc.md`（`settings.*`、`credentials.*` 命令）、`05-contracts/storage-schema.md`（`settings` 表）

---

## 0. 总览

| 项 | 约定 |
|---|---|
| 存储位置 | SQLite `settings` 表中 key = `settings` 的**单个 JSON 文档**（表结构见 storage-schema §5.3）；每个用户一份 |
| 是否含秘密 | **不含任何密钥/激活码/API Key**（秘密见 §9） |
| 读取时机 | 启动时一次；`settings.changed` 事件与命令返回增量同步两个窗口 |
| 写入路径 | 唯一写路径是 `settings.update` / `settings.reset` 命令（含 UI 副作用）；禁止前端直接写文件/DB |
| 版本字段 | `schema_version`（整数，当前 `1`）；迁移规则见 §10 |
| 校验 | JSON Schema（§2，结构）+ 语义校验（§8，跨字段/范围/快捷键合法性）；非法值拒绝整次写入并回滚 |
| 默认值来源 | 本文 §3；代码中不得另写一套默认值，启动时用本文默认值做 normalize |
| 未确认项 | 开机自启、语言、关闭主窗行为、隐私告知确认等**未列入**（见 §12 待定）；避免预先堆字段 |

---

## 1. 设置 JSON 结构（示例，含默认值）

```json
{
  "schema_version": 1,
  "ai": {
    "mode": "official",
    "official": {
      "gateway_url": "https://<fc-default-domain>",
      "device_id": "4b1c2f7e-0a3d-4f6b-9c8e-1f2a3b4c5d6e"
    },
    "byok": {
      "parse": {
        "provider": "deepseek",
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-flash"
      },
      "asr": {
        "provider": "aliyun_bailian",
        "region": "cn-beijing",
        "model": "paraformer-realtime-v2"
      }
    }
  },
  "views": {
    "main": {
      "template": "timeline",
      "timeline": {
        "scale": "day",
        "hour_height_px": 72,
        "range": { "start": "06:00", "end": "24:00" }
      },
      "list": { "scope": "today" }
    },
    "widget": {
      "template": "timeline",
      "timeline": {
        "range": { "start": "07:00", "end": "23:00" }
      },
      "list": { "scope": "today" }
    }
  },
  "widget": {
    "visible": true,
    "geometry": { "x": null, "y": null, "width": 320, "height": 220, "monitor_id": null },
    "opacity": 0.9,
    "material": "auto",
    "reduced_transparency": false
  },
  "shortcuts": {
    "capture": "Ctrl+Alt+Space",
    "toggle_widget": "Ctrl+Alt+W"
  }
}
```

说明：

- `device_id` 为**首次启动生成的随机 UUID v4**（非秘密）。重置设置会重新生成，等同于新设备（配额按设备计，见 gateway-api §6）；内测可接受，公开前评估设备标识稳定性。
- `gateway_url` 随安装包带默认值（作者 FC 默认域名，非秘密）；BYOK 用户也可用它作官方回退。开发调试可填 `http://127.0.0.1:8787`（仅 debug 构建允许 http）。
- `widget.geometry.x/y = null` 表示"默认位置"（主屏工作区右下角、24 px 边距）；用户拖动后写入实际逻辑像素坐标 + `monitor_id`。

---

## 2. JSON Schema（draft 2020-12）

> 运行时校验器必须与本节等价；CI 用同一 schema 校验默认值与迁移样本。`additionalProperties:false`：未知字段在 normalize 时丢弃并写本地 debug 日志（不视为用户错误）。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://clarify.local/schemas/settings-v1.json",
  "title": "Clarify settings",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "ai", "views", "widget", "shortcuts"],
  "properties": {
    "schema_version": { "type": "integer", "const": 1 },
    "ai": {
      "type": "object",
      "additionalProperties": false,
      "required": ["mode", "official", "byok"],
      "properties": {
        "mode": { "type": "string", "enum": ["official", "byok", "rules"] },
        "official": {
          "type": "object",
          "additionalProperties": false,
          "required": ["gateway_url", "device_id"],
          "properties": {
            "gateway_url": {
              "type": "string",
              "pattern": "^https://[^\\s/]+(/[^\\s]*)?$"
            },
            "device_id": { "type": "string", "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }
          }
        },
        "byok": {
          "type": "object",
          "additionalProperties": false,
          "required": ["parse", "asr"],
          "properties": {
            "parse": {
              "type": "object",
              "additionalProperties": false,
              "required": ["provider", "base_url", "model"],
              "properties": {
                "provider": { "type": "string", "enum": ["deepseek"] },
                "base_url": { "type": "string", "pattern": "^https://[^\\s/]+(/[^\\s]*)?$" },
                "model": { "type": "string", "minLength": 1, "maxLength": 64 }
              }
            },
            "asr": {
              "type": "object",
              "additionalProperties": false,
              "required": ["provider", "region", "model"],
              "properties": {
                "provider": { "type": "string", "enum": ["aliyun_bailian"] },
                "region": { "type": "string", "enum": ["cn-beijing", "cn-shanghai", "cn-shenzhen", "cn-hangzhou"] },
                "model": { "type": "string", "minLength": 1, "maxLength": 64 }
              }
            }
          }
        }
      }
    },
    "views": {
      "type": "object",
      "additionalProperties": false,
      "required": ["main", "widget"],
      "properties": {
        "main": {
          "type": "object",
          "additionalProperties": false,
          "required": ["template", "timeline", "list"],
          "properties": {
            "template": { "type": "string", "enum": ["timeline", "list"] },
            "timeline": {
              "type": "object",
              "additionalProperties": false,
              "required": ["scale", "hour_height_px", "range"],
              "properties": {
                "scale": { "type": "string", "enum": ["day", "week", "month"] },
                "hour_height_px": { "type": "integer", "enum": [48, 60, 72, 90, 120] },
                "range": { "$ref": "#/$defs/time_range" }
              }
            },
            "list": {
              "type": "object",
              "additionalProperties": false,
              "required": ["scope"],
              "properties": { "scope": { "type": "string", "enum": ["today", "all"] } }
            }
          }
        },
        "widget": {
          "type": "object",
          "additionalProperties": false,
          "required": ["template", "timeline", "list"],
          "properties": {
            "template": { "type": "string", "enum": ["timeline", "list"] },
            "timeline": {
              "type": "object",
              "additionalProperties": false,
              "required": ["range"],
              "properties": { "range": { "$ref": "#/$defs/time_range" } }
            },
            "list": {
              "type": "object",
              "additionalProperties": false,
              "required": ["scope"],
              "properties": { "scope": { "type": "string", "enum": ["today", "all"] } }
            }
          }
        }
      }
    },
    "widget": {
      "type": "object",
      "additionalProperties": false,
      "required": ["visible", "geometry", "opacity", "material", "reduced_transparency"],
      "properties": {
        "visible": { "type": "boolean" },
        "geometry": {
          "type": "object",
          "additionalProperties": false,
          "required": ["x", "y", "width", "height", "monitor_id"],
          "properties": {
            "x": { "type": ["integer", "null"], "minimum": -32768, "maximum": 32768 },
            "y": { "type": ["integer", "null"], "minimum": -32768, "maximum": 32768 },
            "width": { "type": "integer", "minimum": 260, "maximum": 480 },
            "height": { "type": "integer", "minimum": 140, "maximum": 720 },
            "monitor_id": { "type": ["string", "null"], "maxLength": 128 }
          }
        },
        "opacity": { "type": "number", "enum": [0.75, 0.9, 1.0] },
        "material": { "type": "string", "enum": ["auto", "acrylic", "mica", "solid"] },
        "reduced_transparency": { "type": "boolean" }
      }
    },
    "shortcuts": {
      "type": "object",
      "additionalProperties": false,
      "required": ["capture", "toggle_widget"],
      "properties": {
        "capture": { "type": "string", "pattern": "$ACCELERATOR" },
        "toggle_widget": { "type": "string", "pattern": "$ACCELERATOR" }
      }
    }
  },
  "$defs": {
    "time_range": {
      "type": "object",
      "additionalProperties": false,
      "required": ["start", "end"],
      "properties": {
        "start": { "type": "string", "pattern": "^(?:[01]\\d|2[0-3]):(?:00|15|30|45)$" },
        "end": { "type": "string", "pattern": "^(?:(?:[01]\\d|2[0-3]):(?:00|15|30|45)|24:00)$" }
      }
    }
  }
}
```

> `$ACCELERATOR` 为占位（JSON Schema 数组内不便于写完整 pattern）：实际校验见 §8.4，允许的键名集合 = `[A-Z0-9]`/`F1`–`F24`/`Space`/`Tab`/`Enter`/`Backspace`/`Delete`/`Insert`/`Home`/`End`/`PageUp`/`PageDown`/`ArrowUp/Down/Left/Right`，修饰符 `Ctrl/Alt/Shift/Win` 至少一个、组合不得重复、总长 ≤ 64。

---

## 3. 默认值（唯一来源）

| 路径 | 默认值 | 说明 |
|---|---|---|
| `schema_version` | `1` | 当前版本 |
| `ai.mode` | `"official"` | 三模式见 §5 |
| `ai.official.gateway_url` | 构建期注入（FC 默认域名，占位 `https://<fc-default-domain>`） | 非秘密；可由用户在设置里修改（自部署网关/调试） |
| `ai.official.device_id` | 首次启动生成 UUID v4 | 只用于配额 |
| `ai.byok.parse.provider` | `"deepseek"` | v1 固定；BYOK 解析预设 |
| `ai.byok.parse.base_url` | `"https://api.deepseek.com"` | OpenAI 兼容入口 |
| `ai.byok.parse.model` | `"deepseek-flash"` | 与官方网关同模型 |
| `ai.byok.asr.provider` | `"aliyun_bailian"` | 默认候选（spike 定稿后可能调整，schema 同步） |
| `ai.byok.asr.region` | `"cn-beijing"` | DashScope 地域 |
| `ai.byok.asr.model` | `"paraformer-realtime-v2"` | 实时识别模型 |
| `views.main.template` | `"timeline"` | A 模板为默认 |
| `views.main.timeline.scale` | `"day"` | A 模板尺度：一天 / 7 天 / 日历 |
| `views.main.timeline.hour_height_px` | `72` | 时间轴刻度尺度（每小时像素）；48 紧凑 / 60 / 72 标准 / 90 / 120 舒展 |
| `views.main.timeline.range` | `{"start":"06:00","end":"24:00"}` | 主窗 A 时间范围（可拖拽选区）；**待视觉/UX 复核** |
| `views.main.list.scope` | `"today"` | B 模板：今天 / 全部 |
| `views.widget.template` | `"timeline"` | 悬浮窗 A（仅一天）/ B |
| `views.widget.timeline.range` | `{"start":"07:00","end":"23:00"}` | 悬浮窗 A 时间范围（与主窗**各一套**）；**待视觉/UX 复核** |
| `views.widget.list.scope` | `"today"` | 悬浮窗 B 小切换控件的当前值 |
| `widget.visible` | `true` | 是否显示悬浮窗（Ctrl+Alt+W 也改它） |
| `widget.geometry.x/y` | `null` | null = 默认位置（主屏右下角） |
| `widget.geometry.width/height` | `320 × 220` | 可缩放；范围 §8.5；**待视觉细化** |
| `widget.geometry.monitor_id` | `null` | null = 主显示器 |
| `widget.opacity` | `0.9` | 档位 `0.75 / 0.9 / 1.0`（防调成看不清） |
| `widget.material` | `"auto"` | `auto` = 按系统能力自动选 Mica/Acrylic，失败降级纯色 |
| `widget.reduced_transparency` | `false` | 性能/兼容模式（ADR-0008）：关闭模糊、提高不透明度 |
| `shortcuts.capture` | `"Ctrl+Alt+Space"` | 捕捉 |
| `shortcuts.toggle_widget` | `"Ctrl+Alt+W"` | 显示/隐藏悬浮窗 |

**默认值变更需评审**：任何默认值改动都要同步本文、`02-ux-spec.md`（若涉及交互文案）与迁移测试；不允许代码里出现第二份默认值。

---

## 4. 字段语义与生效时机

### 4.1 `ai.*`

| 字段 | 语义 | 生效时机 | 界面归属 |
|---|---|---|---|
| `mode` | AI 偏好：`official`（默认，零配置）/ `byok`（自带 Key）/ `rules`（纯本地规则，仅文字） | 立即（下一次 AI 调用）；不因单次降级而改写 | 设置页「AI 服务」 |
| `official.gateway_url` | 官方网关地址 | 立即；修改后需 `credentials.test` 重新验证 | 设置页「AI 服务 → 官方服务」 |
| `official.device_id` | 设备标识（随机 UUID） | 启动时若缺失则生成并保存 | 仅展示（不可编辑） |
| `byok.parse.*` | 解析直连配置（OpenAI 兼容） | 立即；Key 不在 JSON 中 | 设置页「AI 服务 → 自带 Key」 |
| `byok.asr.*` | 转写直连配置（形态待 Spike S1 定稿） | 立即 | 同上 |

模式与能力级降级规则见 `04-architecture.md` §5.1；模式切换**不删除**已有凭据（切回即用）。

### 4.2 `views.*`（A/B 模板）

| 字段 | 语义 | 备注 |
|---|---|---|
| `main.template` | 主页面当前模板：`timeline`(A) / `list`(B) | 顶栏切换后持久化 |
| `main.timeline.scale` | A 模板尺度：`day` / `week` / `month`（日历） | 主窗可切；悬浮窗**只有一天**，无 scale |
| `main.timeline.hour_height_px` | A 时间轴每小时像素（刻度尺度） | 紧凑/标准/舒展；影响一天与 7 天视图列高 |
| `main.timeline.range` | 主窗 A 的时间范围（一天/7 天视图生效；日历不用） | 设置里"自由拖拽选区"编辑；语义 §6 |
| `main.list.scope` | B 模板：今天 / 全部 | 清单视图不折叠已完成为主区，仅底部折叠（domain） |
| `widget.template` | 悬浮窗模板：A（只有一天）/ B（今天/全部小切换） | 改设置即时生效 |
| `widget.timeline.range` | 悬浮窗 A 的时间范围（与主窗各一套） | 语义 §6 |
| `widget.list.scope` | 悬浮窗 B 当前 scope（小切换控件直接改它） | 改后立刻持久化 |

### 4.3 `widget.*`（几何/样式）

- `geometry`：逻辑像素（DIP）× 系统缩放；`x/y=null` 走默认位置。用户拖拽/缩放结束 500 ms 防抖后由 Rust 写回（`widget.geometry_changed` 事件同步设置页预览）。
- 恢复策略：若 `monitor_id` 对应显示器不存在，回退主显示器工作区并按默认边距摆放（不丢用户保存值，仅运行时回退；spike S4-6 验证多 DPI）。
- 越界夹取：窗口矩形必须至少 80% 落在某工作区内；不满足则移到最近工作区，运行时不修改保存值。
- `opacity`：0.75 / 0.9 / 1.0 三档；hover 时前端可临时 100%（不改设置）。
- `material`：`auto` 优先 Mica（Win11）→ Acrylic（Win10 1903+）→ `solid`；强制指定失败时自动降级，`widget_get_state.material_effective` 反映实际值。
- `reduced_transparency=true`：关闭毛玻璃、不透明度按下限呈现（性能/兼容模式，ADR-0008 要求必须提供）。

### 4.4 `shortcuts.*`

- 两个快捷键：`capture`（`Ctrl+Alt+Space`）、`toggle_widget`（`Ctrl+Alt+W`）。其余快捷键（如打开主窗）v1.1 未确认，不提供。
- 修改后立即重新注册；冲突 → `CLR-E6001`，**保留旧键继续生效**（不写入失败值）。
- 前端录制快捷键时禁用的组合：仅修饰键、系统保留（`Ctrl+Alt+Del` 等由 Windows 拒绝，直接报冲突）、与另一项重复。

---

## 5. AI 模式与激活码（与凭据的边界）

| 模式 | 需要什么 | 费用承担 | 说明 |
|---|---|---|---|
| `official` | 激活码（凭据管理器）+ 设备 ID（JSON） | 作者（网关配额/预算） | 默认；零配置体验 |
| `byok` | 用户自己的解析 Key（+ 转写 Key，待 S1） | 用户 | Key 在凭据管理器，不写 JSON |
| `rules` | 无 | 无 | 纯文字 + 本地规则；语音不可用 |

- **激活码永不进设置 JSON**：只存 Windows Credential Manager（§9）；设置页显示 `configured + 掩码`，通过 `credentials.status` 获取。
- 激活码校验结果（active/invalid/revoked）是**运行时状态**，不持久化（避免过期状态误导），进 `ServiceStatus`。
- 切换 `ai.mode` 只改偏好；不自动删除另一模式的凭据，也不自动验证。设置页提供「测试连接」（`credentials.test`）。
- 隐私告知（音频/文本发往哪些厂商）位置待定（00-decisions §10-17）；本 schema v1 **不含** `privacy.*` 字段，确认后再加并升 `schema_version`。

---

## 6. 时间范围语义（A 模板）

- `range.start`/`range.end`：本地时间 `HH:mm`；`start < end`；结束允许 `24:00`（仅 end）；步进 15 分钟；最小跨度 2 小时；不支持跨午夜（如 20:00–02:00）——**待定 I4**（若确认支持，需升 schema 并定义跨天轴语义）。
- 作用域：A 一天 / 7 天视图的**时间轴裁剪窗口**；日历（月）视图不受影响（格子按整天）。
- 边界包含规则（产品决策 §5）：事件与选区**有交集即完整显示**，不裁剪时段/不隐藏进行中的事件；选区外的事件不出现在轴上（主窗结果可带 `outside_range` 供 UI 决定是否提示；`02-ux-spec.md` D8 默认"本视图不显示、数据保留"）。
- 主窗与悬浮窗各一套：`views.main.timeline.range` 与 `views.widget.timeline.range`，互不影响。
- 设置页编辑方式：自由拖拽选区（像截图，框外变暗）；越界/最小跨度不满足时不允许保存（UI 限制，后端再校验）。

---

## 7. 悬浮窗几何与样式

| 项 | 默认 | 约束 | 说明 |
|---|---|---|---|
| 宽 | 320 | 260–480 (DIP) | 可缩放；**待视觉细化 §10-3** |
| 高 | 220 | 140–720 (DIP) | 同上 |
| 位置 | 主屏工作区右下角，24 px 边距 | 至少 80% 可见 | 多屏按 `monitor_id` 恢复 |
| 透明度 | 0.9 | 0.75 / 0.9 / 1.0 | 档位制；hover 100% |
| 材质 | auto | auto/acrylic/mica/solid | 失败自动降级，不报错 |
| 性能模式 | false | bool | 关闭模糊 |

- 悬浮窗不提供设置入口（产品决策 §5）：几何/样式只能由主窗设置页或拖拽本身改变。
- 锁定位置/点击穿透/全屏自动隐藏**不在 v1 设置内**（未确认，见 §12）。

---

## 8. 语义校验规则（JSON Schema 之外）

| # | 规则 | 失败处理 |
|---|---|---|
| V1 | `ai.mode` 与凭据无关（可保存无凭据的选择，运行时降级） | — |
| V2 | `gateway_url` 必须 `https://`；仅 debug 构建允许 `http://127.0.0.1[:port]`/`http://localhost[:port]` | 拒绝，`CLR-E1006` |
| V3 | `byok.*.base_url` 必须 `https://`（同 V2 例外） | 拒绝 |
| V4 | 快捷键格式/修饰符/重复见 §4.4；表达式长度 ≤64 | 拒绝 |
| V5 | `time_range`：`start<end`（支持 `end=24:00`）、15 分钟步进、跨度 ≥2 h | 拒绝 |
| V6 | `geometry` 宽高范围；`x/y` 与 `monitor_id` 要么全 null（默认位置）要么 x/y 均非 null | 拒绝（部分来自旧版本时 normalize 修复：丢弃 x/y 回默认） |
| V7 | `opacity` 必须为枚举值 | 拒绝（旧值如 0.85 → normalize 到最近档位并记日志） |
| V8 | `schema_version` 必须等于当前支持版本 | 见 §10 |
| V9 | patch 中出现未知字段、或出现 `api_key`/`activation_code` 等秘密字段名 | 拒绝，`CLR-E1006`（防误把秘密写进 JSON） |
| V10 | 深度合并后整体必须通过 JSON Schema | 拒绝整次写入，**内存与磁盘均保持原值** |

**写入事务性**：`settings.update` = 校验 → 合并 → 整体 Schema 校验 → 语义校验 → 单事务写库 → 应用副作用 → `settings.changed`。任一步失败回滚，返回错误；不允许"部分生效"。

---

## 9. 凭据存储（Windows Credential Manager）

### 9.1 存储目标

| 凭据 | 目标名（Credential Manager Generic Credential） | 内容 | 读写 |
|---|---|---|---|
| 官方激活码 | `Clarify/official/activation-code` | 激活码字符串 | `credentials.set/delete/status/test`，Rust 内部读取 |
| BYOK 解析 Key | `Clarify/byok/deepseek/api-key` | API Key | 同上 |
| BYOK 转写 Key | `Clarify/byok/aliyun/dashscope-api-key` | API Key | 同上 |

- 实现：`keyring` 3.x（Windows 后端 = Credential Manager / DPAPI 加密存储）。持久化作用域、迁移/备份行为（是否随用户配置文件漫游）**待 Spike S6 确认**并回写。
- 目标名在代码中常量定义，本文为唯一事实源；改名需迁移（读取旧名→写新名→删旧名）。
- 凭据按当前 Windows 用户隔离；同一台电脑不同 Windows 用户互不可见。

### 9.2 运行时规则

| 规则 | 要求 |
|---|---|
| 明文可见性 | 只在 Rust 进程内存中出现；`SecretString`/`zeroize` 用完即清；不进入 WebView、不进入日志、不进入设置 JSON、不进入崩溃转储（无对应对象可转储） |
| 回传前端 | **只允许** `configured: bool` + 掩码 `hint`（如 `sk-****3f2a`、`CLR-****-7F3A`）；明文单向（前端 → Rust） |
| 展示 | 设置页只显示"已配置/未配置 + 掩码"；不提供"查看 Key"按钮 |
| 删除 | `credentials.delete` 立即从凭据管理器删除并更新状态；删除后对应能力降级（官方→规则/BYOK；BYOK→官方/规则） |
| 切换模式 | 不迁移/不复制凭据；两套凭据可同时存在 |
| 测试 | `credentials.test` 用凭据发一次最小请求（官方 health 带鉴权 / DeepSeek 仅 1 token 请求 / ASR 用 0.3 s 静音样本），结果不缓存（避免假阳性） |
| 日志脱敏 | 错误日志只允许出现凭据类型与错误码，不出现前缀以外字符 |
| 无备份/导出 | 凭据不可导出；重装系统/换机需重新输入（与"无备份"策略一致，需明示） |

### 9.3 失败处理

| 场景 | 错误码 | 行为 |
|---|---|---|
| 凭据管理器不可用（系统策略/服务异常） | `CLR-E1007` | 不降级为明文落盘；提示用户系统问题 |
| 写入时用户取消 Windows 安全提示 | `CLR-E1007` | 设置页显示未保存 |
| 测试连接失败 | `CLR-E1002/1003/1004/2001/2002` | 显示可行动文案（见 error-taxonomy） |
| 读取时凭据已不存在（被系统清理） | `CLR-E1007` | 视为未配置，更新 `credentials_status` |

---

## 10. 迁移与兼容

### 10.1 版本策略

| 变更类型 | `schema_version` | 处理 |
|---|---|---|
| 新增可选字段（有默认值） | 不升 | normalize 补默认；旧配置文件可直接用 |
| 删除/重命名字段、改变语义/取值范围 | **升 1** | 写迁移函数 `migrate_vN_to_vN+1`；在单事务内改写 JSON 并写回 |
| 新增依赖其他字段的跨字段约束 | 视情况升 | 若旧数据可能违规，升版本并迁移（不静默丢用户数据） |

### 10.2 启动 normalize 流程

1. 读 `settings` 表中 key=`settings` 的行；缺失 → 用默认值创建并写入（首次启动）。
2. JSON 解析失败 → 使用默认值运行，报 `CLR-E1006`（`app.error`，设置页可见"设置已重置"），**不阻塞启动**；原损坏内容只写本地 error 日志（不记录全文，仅长度/位置）。
3. `schema_version` == 当前 → 继续。
4. `schema_version` < 当前 → 顺序迁移（事务内），失败 → 保持旧值、只读设置模式 + `CLR-E1006`（不丢用户旧设置，等待升级修复）。
5. `schema_version` > 当前（降级安装）→ **只读设置模式**：可浏览、可改但**禁止写回**（避免丢掉新字段）；提示升级客户端。
6. 字段级 normalize：缺失补默认、枚举非法修复到默认、未知字段丢弃（debug 日志）、`x/y` 部分缺失修复为默认位置。

### 10.3 测试样本

`spike/` 或测试夹具维护迁移样本：v1 默认值、旧版缺字段、未知字段、损坏 JSON、未来版本、非法枚举。CI 用 JSON Schema 与迁移函数做表驱动测试（见 07-test-strategy）。

---

## 11. 无备份 / 无导出（配置角度的明确承诺）

- 设置 JSON 与凭据**不提供导出/导入/云同步**；`settings.*` 命令中没有 export/import。
- 设置随本机 SQLite 数据库存在；数据库损坏/被删除即丢失（与 00-decisions §7 一致）。
- 卸载是否保留设置（`%LOCALAPPDATA%` 用户数据）由 `11-release-ops.md` 决定；v1 默认保留，安装包不主动清除用户数据。
- 重置设置 ≠ 清空数据：`settings.reset` 只重置设置与视图偏好，**不删除事项、不删除凭据**；"恢复出厂"不在 v1 设置内。

---

## 12. 待定项

| # | 项 | 说明 |
|---|---|---|
| C1 | `views.main.template` 默认 A 还是 B | 本文暂定 A；待 PRD/UX 确认后改默认值 |
| C2 | 主窗/悬浮窗时间范围默认值（06:00–24:00 / 07:00–23:00） | 待视觉/交互评审 |
| C3 | 悬浮窗尺寸范围与默认尺寸（260–480 / 140–720、320×220） | 待视觉细化（00-decisions §10-3） |
| C4 | 是否支持跨午夜时间范围 | I4；当前不支持 |
| C5 | 开机自启、关闭主窗行为、语言、隐私告知确认 | 未确认，v1 schema 不含；确认后加字段并升版本 |
| C6 | 凭据管理器持久化作用域/是否随漫游 | Spike S6 |
| C7 | BYOK ASR 是否直连及 provider 枚举 | Spike S1；若不做，`byok.asr` 字段删除并升 schema 版本 |
| C8 | 悬浮窗锁定位置/点击穿透/全屏隐藏 | 未确认，不进 v1 设置 |
| C9 | 悬浮窗透明度是否可调（02-ux W11/Q12：v1 或固定玻璃质感） | 本 schema 已预留 `widget.opacity/material/reduced_transparency`；若最终固定不可调，字段保留但 UI 不暴露（无需升 schema 版本） |
| C10 | 快捷键是否开放自定义（02-ux §14/Q11/Q20：v1 或固定默认值） | 本 schema 允许存储自定义值；若固定，设置页只读展示，编辑入口延后 |

---

## 13. 变更记录

| 版本 | 日期 | 变更 | 作者 |
|---|---|---|---|
| v0.1 | 2026-11-01 | 首版：设置 JSON Schema、默认值、A/B 视图与时间范围、悬浮窗几何/样式、快捷键、凭据管理器、迁移与校验、无备份承诺 | tech-writer |
