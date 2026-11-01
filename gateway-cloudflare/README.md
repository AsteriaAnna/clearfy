# Clarify 官方网关 — Cloudflare Workers 版

免费额度即可跑早期公开版；Key 只存在 Worker Secrets 里。

```
Clarify 客户端 → Cloudflare Worker
                    ├─ DeepSeek 解析
                    ├─ 豆包流式 ASR（Workers 外连 WebSocket）
                    └─ D1：设备每日额度 / 激活码额度
```

## 免费额度

- Cloudflare Workers 免费计划：请求数、CPU 时间有免费额度（早期足够）
- D1 免费计划：读/写有每日免费额度（额度扣减是低频写入，早期够用）
- 超过后 Cloudflare 免费版会限流/需要升级（$5/月起）

## 部署（需要 Cloudflare 账号）

在仓库根目录执行：

```powershell
cd gateway-cloudflare
npx wrangler login          # 浏览器授权，不需要把密码/Key 给我
npx wrangler d1 create clarify-quota
# 把输出的 database_id 填进 wrangler.toml
npx wrangler d1 execute clarify-quota --remote --file schema.sql
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put DOUBAO_API_KEY
npx wrangler secret put ACTIVATION_SECRET
npx wrangler deploy
```

`ACTIVATION_SECRET` 用 32 位以上随机串，和本地生成激活码的 Secret 保持一致。

部署完成后会输出：

```
https://clarify-gateway.<你的子域>.workers.dev
```

打开 `/v1/health` 验证。

## 激活码

复用 `../gateway/tools/gen-activation.js`：

```powershell
cd ../gateway
$env:ACTIVATION_SECRET = "与 Worker 相同的随机串"
node tools/gen-activation.js --parse 300 --voice 3600 --days 30 --plan plus
```

## 本地联调

```powershell
cd gateway-cloudflare
# 创建 .dev.vars（不要提交）
@"
DEEPSEEK_API_KEY=sk-...
DOUBAO_API_KEY=...
ACTIVATION_SECRET=dev-secret-at-least-32-characters
"@ | Set-Content .dev.vars
npx wrangler d1 execute clarify-quota --local --file schema.sql
npx wrangler dev
```

## 注意

- 大陆不同运营商访问 `*.workers.dev` 差异较大；公开前先让几个大陆朋友实测
- 如果大陆访问不稳，改用 `../gateway/` 的阿里云 FC 版本（去掉 Tablestore 可把成本压到近 0）
- Worker 不存音频/文本，日志不要打印用户内容
- 免费额度/价格以 Cloudflare 控制台为准
