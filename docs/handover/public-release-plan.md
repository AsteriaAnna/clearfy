# 公开版计划：MIT + GitHub + 官方网关

> 状态：2026-11-01 决策，网关代码已就绪，等待阿里云部署后做客户端切换。

## 决策

| 项目 | 决定 |
|---|---|
| 许可证 | MIT（根目录 `LICENSE`） |
| 分发 | 仅 GitHub：源码 + Releases 安装包 |
| AI 架构 | 官方网关（阿里云函数计算 FC）持有 Key，客户端不含 Key |
| Key | 继续使用当前 DeepSeek / 豆包 Key，放在网关环境变量；暂不轮换 |
| 免费额度 | 每设备每天 20 次解析 + 300 秒语音 |
| 激活码 | HMAC 签名；可加解析次数、语音秒数、有效期；不需要账号 |
| 额度存储 | 早期用 Cloudflare D1（免费额度）；阿里云备选 Tablestore |
| 客户端配置 | 用户不需要配置 Key；可选填激活码 |
| 早期部署 | **Cloudflare Workers + D1**（我可以 wrangler 部署）；阿里云 FC 作为大陆访问不稳时的备选 |

## 架构

```
公开 GitHub（MIT，无 Key）
  ├─ 客户端源码
  └─ Releases 安装包（无 Key）

阿里云 FC 网关（私有部署）
  ├─ /v1/parse      → DeepSeek
  ├─ /v1/transcribe → 豆包流式 ASR
  ├─ /v1/quota
  └─ Tablestore 额度 / 激活码校验
```

## 已完成

- `gateway/` Node.js 20 阿里云 FC 网关源码（本地已测：health / parse / transcribe / 激活码额度）
- `gateway-cloudflare/` Cloudflare Workers + D1 网关源码（本地 wrangler dev 已测：health / parse / transcribe / D1 额度 / 激活码）
- 免费额度 + 激活码校验 + 两种额度存储
- 部署文档：`gateway/README.md`、`gateway-cloudflare/README.md`
- 激活码生成：`gateway/tools/gen-activation.js`
- `LICENSE`（MIT）
- 网关代码没有 Key；Key 只在云平台环境变量/Secrets

## 待用户操作（部署）

1. 阿里云创建 Tablestore 实例 + 表 `clarify_quota`（主键 `pk` String）
2. 创建函数计算 FC Node.js 20 函数，上传 `gateway/clarify-gateway.zip`
3. 配置环境变量（见 `gateway/README.md`）
4. 创建 HTTP 触发器，拿到函数 URL
5. 把 URL 发回；不要发 AccessKey/API Key

## 部署后我继续做

1. 客户端移除 `option_env!` 内置 Key，改为调网关
2. 首次启动/设置里加“额度查询 + 激活码输入”（无 Key 配置）
3. 隐私授权文案（音频/文本会发到云端）
4. 重新打不含 Key 的安装包 + GitHub Release 说明
5. 可选：代码签名、自动更新
