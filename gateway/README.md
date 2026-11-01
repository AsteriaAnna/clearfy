# Clarify 官方 AI 网关（阿里云函数计算）

客户端只调用这个网关；DeepSeek / 豆包 Key 只在网关环境变量里。

```
Clarify 客户端
  ├── POST /v1/parse       { text, nowLocal, deviceId, activationCode? }
  └── POST /v1/transcribe  { pcmBase64, deviceId, activationCode? }
        │
        ▼
阿里云函数计算（Node.js 20）
  ├── DeepSeek API
  ├── 豆包流式 ASR（WebSocket）
  └── Tablestore：按设备/激活码扣额度
```

## 额度

- 免费：每设备每天 **5 次解析 + 30 秒语音**（首版默认）
- 激活码：额外解析次数/语音秒数/有效期，HMAC 签名，不需要账号
- `QUOTA_MODE=client`（默认部署）：不接 Tablestore，网关只验激活码签名，**额度由客户端计数**；零存储成本，但技术用户可绕过
- `QUOTA_MODE=server`：接 Tablestore 做服务端扣减（更严格，需额外服务）
- 规则优先：简单中文时间/计数由客户端规则解析，不调 AI；只有规则拿不准才走 DeepSeek

环境变量可调 `FREE_PARSE_PER_DAY`、`FREE_VOICE_SECONDS_PER_DAY`。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/health` | 检查 Key/Tablestore 是否配置 |
| GET | `/v1/quota?deviceId=...&code=...` | 查询剩余额度 |
| POST | `/v1/parse` | `{ text, nowLocal, deviceId, activationCode? }` → `{ tasks, quota }` |
| POST | `/v1/transcribe` | `{ pcmBase64, deviceId, activationCode? }` → `{ text, quota }` |

## 部署步骤（阿里云控制台）

### 1. 创建 Tablestore 实例和表

1. 阿里云 → 表格存储 Tablestore → 创建实例（地域与函数计算一致，例如 `cn-hangzhou`）
2. 创建数据表：
   - 表名：`clarify_quota`
   - 主键：`pk`，类型 **String**
   - 不需要额外属性列
3. 记录实例名和 Endpoint（如 `https://xxx.cn-hangzhou.ots.aliyuncs.com`）

### 2. 创建函数计算函数

1. 阿里云 → 函数计算 FC → 创建函数
2. 类型：**Web 函数 / HTTP 函数**；运行环境：**Node.js 20**
3. 函数名称：`clarify-gateway`；内存 256MB；超时 60 秒
4. 上传代码：

```powershell
cd gateway
npm install --omit=dev
powershell -ExecutionPolicy Bypass -File tools/pack.ps1
# 生成 clarify-gateway.zip，在控制台上传
```

5. 设置环境变量：

| 变量 | 说明 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek Key |
| `DOUBAO_API_KEY` | 豆包语音 API Key |
| `ACTIVATION_SECRET` | 随机 ≥32 字符，用于签名激活码；生成后不要丢 |
| `TABLESTORE_ENDPOINT` | 表格存储 Endpoint |
| `TABLESTORE_INSTANCE` | 表格存储实例名 |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | 有 Tablestore 读写的 RAM 用户 AccessKey |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | 同上 |
| `FREE_PARSE_PER_DAY` | 可选，默认 20 |
| `FREE_VOICE_SECONDS_PER_DAY` | 可选，默认 300 |

> 更安全的做法是给函数一个只允许 Tablestore 的 RAM 角色；当前代码用环境变量 AccessKey，先跑通再升级。

6. 创建 HTTP 触发器（匿名访问），拿到公网 URL，例如：
   `https://clarify-gateway-xxxx.cn-hangzhou.fcapp.run`

### 3. 验证

> 阿里云函数 URL 默认会在响应头加 `content-disposition: attachment`，用浏览器打开会**下载文件**而不是显示页面，这是 FC 的默认行为，不代表网关失败。

用命令行验证：

```powershell
(Invoke-WebRequest 'https://你的函数URL/v1/health').Content
```

或：

```bash
curl https://你的函数URL/v1/health
```

看到 `{"ok":true,...}` 即成功。需要浏览器页面时可绑定自定义域名，或在后续配置 API 网关。

### 4. 生成激活码

在本地（不要提交 Secret）：

```powershell
$env:ACTIVATION_SECRET = "与网关相同的随机串"
node tools/gen-activation.js --parse 300 --voice 3600 --days 30 --plan plus
```

输出一个 `CLR1.xxx.xxx` 激活码；客户端填写后获得额外额度。

## 本地开发

```powershell
cd gateway
npm install
$env:ACTIVATION_SECRET = "dev-secret-at-least-32-characters"
node dev-server.js
# http://localhost:8787/v1/health
```

本地没有 Tablestore 时额度存在内存（`memoryOnly: true`），只用于联调。要测 DeepSeek/豆包需配置 Key。

## 费用与安全

- 函数计算 + Tablestore 小规模通常免费额度内/几元每月
- DeepSeek 解析 ≈ ¥0.0003–0.001/次；豆包语音 ≈ ¥0.86/小时
- 每日免费额度 + 激活码 + API 网关限流，防止被刷
- **不要把 Key 写进代码/仓库**；不要把阿里云 AccessKey 发到聊天里
- 公开仓库只放网关源码和部署文档，环境变量在控制台配置
- 生产建议：函数 RAM 角色替代 AccessKey、API 网关加 QPS 限流、日志里不要打印用户文本/音频
