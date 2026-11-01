# ADR-0002：AI 供应商选型（ASR 用最便宜国内厂商 + DeepSeek 解析）

- 状态：Proposed（DeepSeek 部分已定；ASR 待 spike 按规则最终确认）
- 日期：2026-11-01
- 关联：`00-product-decisions.md` §3/§9；`docs/research/tech-stack.md`

## 背景

用户要求语音识别用"最便宜的国内厂商"，文本解析用 DeepSeek。价格需可核实，且接口形态要能被网关统一适配。

## 决策

### 文本解析（已定）
- **DeepSeek `deepseek-flash`**，非思考模式 + JSON Output；固定模型名，版本变化必须跑评估集回归。
- 价格（2026-11-01 官方）：每 1M tokens 输入 $0.15（低峰）/$0.30（高峰），输出 $0.60/$1.20；单次解析约 ¥0.003~0.007。

### 语音识别（默认候选，spike 决定）
- 默认候选：**阿里云百炼 `paraformer-realtime-v2`**（¥0.00024/秒，约 ¥0.86/小时；实时 WebSocket）。
- 对比候选：腾讯云一句话识别（同步 HTTP，价格待核实）、讯飞语音听写（套餐约 ¥0.005/次，新用户 50 万次/年免费包）。
- **选择规则（预先固定）**：在"中文准确率（字准）≥95% 且 10s 音频 P95 延迟 ≤1.5s"的候选中，选每用户每月成本最低者；若最低两者成本差 <10%，选接入更简单的（同步 HTTP 优先）。
- 网关侧做 provider 适配层，不把供应商写死在客户端。

## 后果

- 正面：成本极低（单次捕捉约 ¥0.006~0.01）；解析质量好；可换供应商。
- 负面：ASR 若只有 WebSocket，网关需内置 WS 客户端；供应商价格/条款可能变化；需逐字段评估 AI 幻觉。
- 必须为每个供应商做真实录音对比（spike S1），并记录到 `docs/research/spike-results.md`。

## 备选

- 全本地 ASR：已否决（效果/体积/CPU）。
- 其他国内厂商：保留为适配器，不进入默认路径。

## 关联

`05-contracts/gateway-api.md`、`ops/official-ai-gateway-setup.md`、`07-test-strategy.md`
