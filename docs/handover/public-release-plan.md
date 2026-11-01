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
| 早期部署 | **阿里云 FC 免费额度**（大陆稳定）；Cloudflare 实测不可用（见下） |
| 额度存储 | 首版先不做服务端计数：客户端计数 + 激活码签名 + API 预算告警；有量后再接 Tablestore/Redis |

## 2026-11-01 Cloudflare 实测结论

- 本机访问 `workers.dev` 返回 200，但 **`dash.cloudflare.com` 返回 403**，`wrangler login` 两种方式都超时，无法登录/创建账号
- 用户主要在大陆，`*.workers.dev` 各省差异大，不适合作为大陆主线路
- Cloudflare Worker + D1 代码已写好（`gateway-cloudflare/`，本地 wrangler 跑通），保留为海外/备选方案
- 结论：**公开主线路用阿里云函数计算**

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

## 部署与客户端状态（2026-11-01）

- ✅ 阿里云 FC 已部署：函数 `clarify-gateway`（cn-hangzhou，nodejs20，256MB）
- ✅ HTTP 触发器（匿名 GET/POST）
- ✅ 函数 URL：`https://clarify-gateway-dsidnsbafc.cn-hangzhou.fcapp.run`
- ✅ `/v1/health`、`/v1/parse`、`/v1/transcribe` 实测通过
- ✅ 额度模式：`QUOTA_MODE=client`，免费 5 次解析 + 30 秒语音/天
- ✅ 客户端已迁移：删除内置 Key，文字/语音走网关；设置页有额度和激活码
- ✅ 公开版安装包正在重建（不含 Key）
- ✅ 激活码 Secret 在本机 `%LOCALAPPDATA%\com.clarify.desktop\gateway-activation-secret.txt`
- ⚠️ `s deploy` 输出把函数环境变量打印出来了；公开前建议轮换 DeepSeek/豆包 Key
- ⚠️ 当前函数 URL 匿名可调，客户端计额度可被绕开；有量后加 Tablestore/Redis/API 网关限流
- ⚠️ FC 默认域名会强制 `content-disposition: attachment`，浏览器打开会下载；用命令行验证，客户端不受影响

## 待用户操作（部署）

1. 打开函数 URL `/v1/health` 确认
2. **立刻禁用/删除用于部署的 AccessKey**（已贴到对话里）
3. 找 2～3 个不同省份/运营商的朋友打开 `/v1/health` 测大陆访问
4. 反馈结果：稳定则用这个 URL 切客户端；不稳定则走阿里云国内域名/备用方案

## 部署后我继续做

1. 客户端移除 `option_env!` 内置 Key，改为调网关
2. 首次启动/设置里加“额度查询 + 激活码输入”（无 Key 配置）
3. 隐私授权文案（音频/文本会发到云端）
4. 重新打不含 Key 的安装包 + GitHub Release 说明
5. 可选：代码签名、自动更新
