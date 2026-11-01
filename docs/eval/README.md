# AI 解析评估集（Eval Set）

- 文档 Owner：领域与契约写手（W2）
- 版本：v1.0（2026-11-01，初稿，待红队审查）
- 配套数据：`sentences.json`（62 条中文口语）、`expected.json`（逐条期望输出）
- 契约：`docs/05-contracts/ai-json.md`（输出 Schema v1.0、提取规则 R1–R14、失败处理）
- 领域：`docs/03-domain-model.md`（字段、形态、24h、周期/计数语义）
- 用途：AI 解析（prompt/模型/网关）每次变更的**回归门禁**；不达标不得默认启用 LLM 解析（走规则模式）

> 原则：评估集只评**文本解析**（transcript → actions），不评 ASR 音频质量；所有句子为合成语料，不含真实用户数据、真实姓名与真实密钥。

---

## 1. 文件与固定锚点

| 文件 | 内容 |
|---|---|
| `sentences.json` | 句子集：`id` / `text` / `category` / `note`；含分类计数元数据 |
| `expected.json` | 期望输出：`expected[id].actions`，逐条符合 `ai-json.md` 输出 Schema；`anchor` 固定 |
| `README.md` | 本文：指标、口径、达标线、runner 规格、维护规则 |

**固定锚点（所有期望时间据此计算，runner 必须使用相同值）**：

```json
{ "now": "2026-11-01T16:30:00+08:00", "timezone": "Asia/Shanghai" }
```

- `2026-11-01` 是**周日**（ISO 周 44，周一为一周之始）；"明天"=11-02 周一，"下周三"=11-04，"周五"=11-06。
- 两条数据文件的 `anchor` 必须一致；runner 发现不一致直接报错退出（防止"用今天的日期跑昨天的期望"）。

---

## 2. 数据格式

### 2.1 `sentences.json`

```json
{
  "version": "1.0",
  "contract_version": "1.0",
  "anchor": { "now": "2026-11-01T16:30:00+08:00", "timezone": "Asia/Shanghai" },
  "categories": { "single_datetime": { "zh": "单次时点", "count": 10 } },
  "sentences": [
    { "id": "s001", "text": "明天下午三点跟张总开会", "category": "single_datetime", "note": "相对日 + 下午时刻" }
  ]
}
```

- `id`：`s001`…`s062`，**永不复用/不改语义**（新增用例追加新 id）。
- `text`：模拟 ASR 最终文本（口语原样，含"呃/那个/啊"等）。
- `category`：见 §3；`note`：该条要验证的规则/边界（给人看，不参与打分）。

### 2.2 `expected.json`

```json
{
  "version": "1.0",
  "contract_version": "1.0",
  "anchor": { "now": "2026-11-01T16:30:00+08:00", "timezone": "Asia/Shanghai" },
  "expected": {
    "s001": {
      "actions": [
        { "title": "跟张总开会",
          "time": { "kind": "datetime", "start": "2026-11-02T15:00:00+08:00" },
          "repeat": null, "count": null }
      ]
    }
  }
}
```

- 校验方式：把 `expected[id].actions` 包成 `{"version":"1.0","actions":[...]}`，整体通过 `ai-json.md` §3.1 Schema + §4.1 语义校验（CI 强制）。
- 期望输出**不含** `id`/`created_at` 等落库字段：那些由客户端生成，不属于 AI 契约。

---

## 3. 覆盖矩阵（62 条）

| 分类（英文） | 中文 | 条数 | 覆盖规则/边界 |
|---|---|---|---|
| `single_datetime` | 单次时点 | 10 | R1/R3/R5/R11/R13；相对日、绝对日期、星期、相对偏移、跨月、半点/非整点 |
| `single_range` | 单次时段（含时段+截止） | 8 | R5/R6；时段 start–end、半小时边界、跨天不裁、deadline 语义 |
| `recurrence` | 周期重复 | 8 | R9/R11；day/week/month、interval、weekdays、日期型重复、当前 occurrence |
| `count` | 计数目标 | 6 | R10；target/period、数量进 count、标题去数量、count 与 time 互斥 |
| `no_time` | 无时间/想法 | 7 | R1/R7；无时间线索→none；"记得"等语气词剔除 |
| `multi_action` | 多动作拆分与时间继承 | 8 | R2/R6；拆 2–3 条、共用时间继承、每条独立时间 |
| `vague_time` | 模糊时间（不解析） | 5 | R4/R7；晚上/上午/尽快/下午/改天 → none |
| `speech_slip` | 口误/口水词 | 4 | R1/R2；填充词剔除、重复口述合并、无意义短语 |
| `adversarial` | 对抗/不支持表达 | 6 | R8/R12；"提醒我"无提醒字段、"早中晚各一次"计数 3/天、"这个月"不解析、每月计数不支持、"每天学习"无时间基准不解析重复、"明天两点"无上下午只解析日期 |

- 分类的 `count` 必须与 `sentences.json.categories` 一致（CI 校验）。
- 任何新增契约规则（如未来支持"每月计数"）必须新增/更新对应用例；**不得**通过改 `expected.json` 来"迁就"实现。

---

## 4. 指标定义

记：`N = 62`（句数），`E` = 期望动作总数，`P` = 预测动作总数。

### 4.1 JSON 合法率

- **首次合法率** = 第一次响应即通过（JSON 语法 + Schema + 语义校验）的句数 / N。
- **最终合法率** = 重试 1 次后仍通过（或经合法重试后通过）的句数 / N；**必须 100%**。
- 一次响应"合法"= 解析为 JSON 对象、通过 `ai-json.md` §3.1 Schema、通过 §4.1 语义校验、`actions` 非空。`actions > 5` 记为不合法（`E-TOO-MANY`），但允许客户端截前 5 后落库，评估仍记为首次不合法。
- 统计并报告失败类型分布：`json_syntax` / `schema` / `semantic` / `empty` / `too_many` / `version`。

### 4.2 动作标题保真（Title Fidelity）

1. 标题规范化：去掉首尾空白；去掉中英文标点与空白（`，。！？、：；""''（）` 与 `,.!?;:` 等），其余字符保留；不做同义词替换。
2. 相似度：`sim = 1 - levenshtein(期望标题, 预测标题) / max(len(期望标题), len(预测标题))`，范围 [0,1]。
3. 只在**已对齐的动作对**上计算（对齐规则见 §4.4）；取算术平均（macro）。
4. 额外硬检查（报告但不单独卡门禁）：标题等于原句、或含"呃/那个/就是/啊/吧/提醒我/记得"等语气词 → 记录 `title_style_violation`，供 prompt 调优。

- 期望标题口径（与 `expected.json` 一致）：**动宾/动词性动作短语**；不含时间词、数量词、语气词；如"每天三杯水"→"喝水"，"每天背五十个单词"→"背单词"，"把发票报销了"→"报销发票"，"把报告写完"→"写完报告"。

### 4.3 时间字段准确率

- 对**已对齐**动作对逐字段判定（动作级"全对"才算正确，避免部分分掩盖错误）：
  - `kind` 必须一致；
  - `date`：本地日期完全相同；
  - `datetime`：`start` 换算 UTC 后精确到**分钟**相同；
  - `range`：`start`/`end` 精确到分钟相同；`deadline` 是否存在也必须一致且时间相同。
- **时间准确率** = 时间全对的对齐动作数 / 对齐动作数（主指标）。
- 同时报告**端到端时间正确率** = 时间全对的对齐动作数 / E（辅助观察拆分损失）。
- 另报 `date_only_accuracy` / `datetime_accuracy` / `range_accuracy` 三个子项，便于定位。

### 4.4 拆分 F1

1. 对齐：每句构造二分图。候选边 = 期望动作 i 与预测动作 j 的标题相似度 `sim >= 0.6`（同 §4.2 规范化）。
2. 贪心最大匹配：按 `(-sim, i, j)` 排序后贪心取边（确定性；同分按期望/预测下标升序）。
3. 汇总（micro）：
   - `TP` = 全部对齐对数；
   - `FP = P - TP`；`FN = E - TP`；
   - `precision = TP / max(1, P)`，`recall = TP / max(1, E)`，`F1 = 2PR/(P+R)`。
4. 另报每类 F1 与"多拆/少拆"计数（把 1 句拆成多条时 FP 增加的具体句子 id）。

### 4.5 不幻觉率（Hallucination Rate）

- **幻觉动作**：满足任一条即计一次幻觉——
  1. 对齐动作：期望 `time.kind = none`，预测 `kind != none`（无中生有时间）；
  2. 未对齐的预测动作：`time.kind != none`（凭空多出一条带时间的事项）；
  3. 期望 `time.kind != none` 但预测 `time` 与期望 `kind` 不同且无原文依据（如期望 date、预测 datetime 属时间错误，不计幻觉；仅"无依据新增时间"计幻觉）。
- `幻觉率 = 幻觉动作数 / E`；**达标线 = 0（不幻觉率 100%）**。这是硬红线（Charter：幻觉日期 = 0）。
- "期望 none 却预测 none"是正确；"期望有日期而预测不同日期"计入 §4.3 时间准确率，不计幻觉。

### 4.6 周期/计数字段准确率

- 对已对齐动作：`repeat` 完全相等（freq/interval/weekdays 三项）且 `count` 完全相等（target/period；或都为空）才正确。
- `周期/计数准确率` = 正确数 / 期望中 `repeat` 或 `count` 非空的对齐动作数（主指标）；子项分 `repeat_accuracy` / `count_accuracy`。
- 与时间准确率互不重叠：时间错了不影响本项（本项只看 repeat/count）。

### 4.7 延迟

- **解析 P95**：单次 AI 请求（含 1 次重试则取最终成功那次；不含网络排队）wall-clock P95；达标 **≤ 3000 ms**。
- **端到端 P95**（产品级，本评估集不测音频）：捕捉停止 → 解析结果落库 UI 可见 ≤ 4000 ms（Charter 成功指标），由性能测试单独覆盖（见 `07-test-strategy.md`）。
- 报告 P50/P95/P99、失败请求耗时不入 P95（单列 timeout 率）。

### 4.8 兜底率

- LLM 最终失败（网络/超时/非法 JSON/语义错/空 actions）→ 规则模式或原文兜底 的句数 / N；达标 **≤ 2%**。
- `too_many`（>5 条）不计入兜底（仍落库前 5 条），但计入首次不合法率。

### 4.9 误建率

- **误建**：不该建却建——未与任何期望动作对齐的预测动作（FP）计入。`误建率 = FP / E`；达标 **≤ 2%**。
- 把 1 个动作拆成 2 条会同时产生 1 个 FP（多建）与可能的 FN（少建），二者分别计入对应指标。
- 与幻觉的关系：未对齐且带非 none 时间的预测动作**同时**计入误建率与幻觉数（双重红线）。
- 与 `07-test-strategy.md` §8.1 的"误建率 ≤2%"口径对齐。

---

## 5. 达标线（发布门禁）

| 指标 | 达标线 | 说明 |
|---|---|---|
| JSON 合法率（首次） | **≥ 99%** | 62 条中最多 0 条失败（61/62 = 98.4% < 99%，取整判定需 62/62）。注：`07-test-strategy.md` 写"重试后 ≥99%"，本表更严格（首次 ≥99%、最终 100%），以本文件为准（07 已声明以 `docs/eval/README.md` 为准） |
| JSON 合法率（重试后最终） | **100%** | 重试仍非法 → 走兜底，不能进生产 |
| 时间字段准确率 | **≥ 90%** | 主指标；按对齐动作计；另按 date/datetime/range 分子项 |
| 不幻觉率 | **100%（幻觉动作 = 0）** | 硬红线 |
| 拆分 F1 | **≥ 0.80** | micro F1 |
| 动作标题保真 | **≥ 0.85** | macro 相似度 |
| 周期/计数准确率 | **≥ 95%** | repeat + count |
| 误建率 | **≤ 2%** | FP / E；与 `07-test-strategy.md` §8.1 对齐 |
| 解析 P95 | **≤ 3000 ms** | 单次请求 |
| 兜底率 | **≤ 2%** | 62 条中 ≤1 条 |
| 分类覆盖 | 每类 ≥1 条 | 数据完整性 |
| 分类时间准确率 | 每类 ≥70%（警告） | 不单独卡门禁，低于则列红 |

- 任一硬指标不达标 → **不得默认启用 LLM 解析**，回退规则模式（产品决策 v1.1 + Charter 成功指标）。
- 门禁项与阈值变更必须走文档评审 + 决策登记（`10-risks-decisions.md`）。

---

## 6. 评分规则与口径细节

1. **归一化**：比较前统一全角/半角标点（仅标点与空白），中文数字不做自动转换（期望值已写阿拉伯数字，如"三杯"→3 是模型职责）。
2. **时区**：所有时间比较先换算为 UTC；`+08:00` 与 `Z` 表示同一时刻应判定相等。秒必须为 `00`（契约要求）。
3. **分母口径**：
   - 时间准确率、标题保真、周期/计数准确率：分母 = 对齐动作数；
   - 拆分 F1：micro 汇总（TP/FP/FN 跨句累加，不是每句 F1 平均）；
   - 幻觉率：分母 = E（期望动作总数）。
4. **未对齐的期望动作**：计入 FN（拆分 F1），同时时间/标题指标不参与（因为没有对应预测），但要单列"漏动作数"。
5. **多余预测动作**：计入 FP；若带非 none 时间 → 另计幻觉（§4.5）。
6. **同一句多次运行**：官方结果只取一次运行（`--repeat 1`）；发布候选（RC）跑 3 次，**3 次都必须过门禁**，报告每次指标与波动区间；不得取最好一次。
7. **结果落档**：每次运行生成报告 JSON（§7.3）写入 `docs/eval/runs/`（可按 `07-test-strategy.md` §8.5 另存一页 Markdown 摘要），并与上次基线比较（回归：时间准确率下降 >2pp 或 F1 下降 >0.05 → 告警）。
8. **人工复核**：任何一次运行中出现 `title_style_violation`、幻觉、或某类准确率 <70%，需人工查看该句预测并决定是 prompt 问题还是期望值问题（期望值变更必须走 §8 规则）。

---

## 7. Runner 规格

### 7.1 形态与职责

- **独立 CLI**（不嵌入产品主流程、不打包进安装包）：建议 `clarify-eval`（Rust bin）或 Node 脚本，二选一由 08-engineering 定；本文件只约定接口与行为。
- 读取 `sentences.json` + `expected.json`；按固定锚点构造输入；调用 AI 解析（官方网关或 BYOK 直连，同一契约）；按 §4 计算指标；输出报告 + 退出码。
- **不测 ASR、不测 UI、不测网络质量**；不做真实音频回放。
- CI 中必须有 `--dry-run`（只校验数据集与 Schema，不发请求），保证数据集本身永远合法。

### 7.2 CLI 接口（约定）

```bash
clarify-eval \
  --sentences docs/eval/sentences.json \
  --expected  docs/eval/expected.json \
  --endpoint  https://<gateway>/v1/parse \
  --model     deepseek-flash \
  --prompt-version p1.0 \
  --contract-version 1.0 \
  --repeat    1 \
  --timeout-ms 5000 \
  --out       docs/eval/runs/<run-id>.json
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `--sentences` / `--expected` | 是 | 数据集路径；anchor/version 必须一致 |
| `--endpoint` | 是（`--replay` 时否） | 官方网关或 OpenAI 兼容端点 |
| `--model` | 是 | 固定 `deepseek-flash`；用于报告与回归对比 |
| `--prompt-version` | 是 | 如 `p1.0`；与服务端记录一致 |
| `--contract-version` | 是 | 当前支持 `1.0` |
| `--repeat` | 否 | 默认 1；RC 用 3 |
| `--timeout-ms` | 否 | 默认 5000 |
| `--replay <file>` | 否 | 离线回放：从历史响应文件重算指标，不联网（用于排查/对比） |
| `--dry-run` | 否 | 只做数据集/Schema/期望合法性校验，不发请求 |
| `--fail-fast` | 否 | 首条不合法即停（调试用） |

- 凭证：从环境变量（如 `CLARIFY_EVAL_API_KEY`）或 Windows 凭据管理器读取；**禁止**写入命令行历史、报告或仓库。
- 并发：默认串行（=1），保证延迟测量可比与请求可复现；可用 `--concurrency` 调试，但正式结果必须串行。
- 退出码：`0` = 全部达标；`1` = 有门禁不达标；`2` = 数据集/配置错误；`3` = 认证/额度错误。

### 7.3 报告 JSON（必须包含）

```json
{
  "run": {
    "run_id": "2026-11-01T09-00-00Z",
    "started_at": "2026-11-01T09:00:00Z",
    "duration_ms": 123456,
    "git_commit": "<sha>",
    "model": "deepseek-flash",
    "prompt_version": "p1.0",
    "contract_version": "1.0",
    "anchor": { "now": "2026-11-01T16:30:00+08:00", "timezone": "Asia/Shanghai" },
    "repeat": 1,
    "concurrency": 1
  },
  "metrics": {
    "json_valid_first_rate": 1.0,
    "json_valid_final_rate": 1.0,
    "time_accuracy": 0.95,
    "time_accuracy_end_to_end": 0.9,
    "split_precision": 0.93,
    "split_recall": 0.9,
    "split_f1": 0.915,
    "title_fidelity": 0.92,
    "hallucination_count": 0,
    "hallucination_rate": 0.0,
    "false_create_rate": 0.0,
    "repeat_accuracy": 1.0,
    "count_accuracy": 1.0,
    "period_count_accuracy": 1.0,
    "fallback_rate": 0.0,
    "latency_ms": { "p50": 900, "p95": 2200, "p99": 4000, "timeout_rate": 0.0 },
    "per_category": {
      "single_datetime": { "n": 10, "time_accuracy": 1.0, "split_f1": 1.0, "title_fidelity": 0.95 }
    }
  },
  "gate": {
    "passed": true,
    "failed": []
  },
  "samples": [
    {
      "id": "s001",
      "json_valid_first": true,
      "schema_valid": true,
      "semantic_valid": true,
      "fallback": false,
      "latency_ms": 800,
      "predicted": [ { "title": "跟张总开会", "time": { "kind": "datetime", "start": "2026-11-02T15:00:00+08:00" }, "repeat": null, "count": null } ],
      "aligned": [ { "expected": 0, "predicted": 0, "title_sim": 1.0, "time_ok": true, "repeat_ok": true, "count_ok": true } ],
      "title_style_violation": false
    }
  ]
}
```

- 报告中的句子/预测只来自**合成评估集**，可提交仓库或 CI 工件；不得写入真实用户数据。
- 报告不包含请求头、Key、音频、原始网关响应全文（只保留校验所需的结构化字段与失败错误码）。

### 7.4 运行时机（门禁）

| 时机 | 要求 |
|---|---|
| 每次修改 prompt / 提示词版本 | 全量跑，必须过门禁 |
| 每次更换/升级模型、厂商 | 全量跑 + RC 3 次 |
| 发布候选（RC / 内测发版） | 全量跑 3 次，全部过门禁 |
| 每周定期 | 全量跑 1 次，落基线 |
| 数据集变更（新增句子/期望） | 先跑 `--dry-run` + 全量重跑旧集合（防止回归），再更新基线 |
| CI（每次 PR 涉及 AI 契约/prompt） | `--dry-run` 必跑；联网全量由人工/定时任务跑（不依赖 CI 网络与密钥） |

---

## 8. 数据集维护规则

1. **id 不可变**：`s001`…`s062` 的 `text` 与语义固定；新增用例从 `s063` 起追加，不得插入重排。
2. **期望值可修**：只有"期望值本身错了"或"契约变更"才允许改 `expected.json`；修改 PR 必须说明依据（引用 `ai-json.md` 规则编号）并跑全量。
3. **契约变更同步**：`ai-json.md` 版本升级 → `contract_version` 同步；不兼容变更（MAJOR）需新建评估集版本，旧集合保留作回归对照。
4. **数量下限**：句子 ≥50（当前 62），分类覆盖必须满足 §3；新增能力（如未来支持"每月计数"）必须补对应正例/反例；`07-test-strategy.md` §8.2 要求的四类强制样本（模糊词留空 / 共享时间继承 / 无时间基准的重复不解析 / 无上下午钟点只解析日期）已分别由 `vague_time`、`multi_action`、`s061`、`s062` 覆盖。
5. **模糊性把关**：一句话的期望必须能由 `ai-json.md` 规则**唯一推出**；存在两种合理解析的句子不得入集（宁可少，不可歧义）。与 `00-product-decisions.md` 待定项相关的行为（如兜底标题 §10-4）暂不设期望（不测）。
6. **隐私**：只用合成句；不得粘贴真实用户语音文本、真实人名/公司/电话/地址（示例中的"张总/王工"为通用代称）。

---

## 9. 已知限制与开放问题

| 项 | 状态/影响 |
|---|---|
| 兜底标题策略（原文 vs 空） | `00-product-decisions.md` §10-4 待定；本评估集不含"完全无法动作化"的句子，避免把临时默认固化成期望 |
| 原文留存 / 重新解析 | §10-5、D28 待定；不影响本评估集（只用合成文本） |
| ASR 质量 | 不在本集范围；由 spike（D5）与语音测试覆盖 |
| 多动作 >5 条 | 契约规定取前 5；本集每条 ≤3 个动作，未覆盖截断行为（若产品需要，后续补专门用例并明确期望） |
| 英文/中英混说 | v1 不评估（目标语言中文） |
| 节日/农历/月底 | v1 明确不解析（R11/R12），以 `vague_time`/`adversarial` 类覆盖"不解析"行为，不设解析期望 |
| 计数周期只支持 day/week | "每月 N 次"在 `adversarial` 中验证"不解析 count、不编时间"（当前模型不支持该形态） |

---

## 变更记录

| 版本 | 日期 | 变更 | 来源 |
|---|---|---|---|
| v1.0 | 2026-11-01 | 首版：62 条九分类评估集；指标定义（JSON 合法率/标题保真/时间准确率/拆分 F1/幻觉率/误建率/周期计数/延迟/兜底率）；达标线与 runner 规格 | `00-product-decisions.md` v1.1 + `05-contracts/ai-json.md` v1.0 |
