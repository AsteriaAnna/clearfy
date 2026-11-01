# 存储契约（SQLite Schema）

- 文档 Owner：领域与契约写手（W2）
- 版本：v1.1（2026-11-01，初稿 + 按用户确认口径修订，待红队审查）
- 状态：开发前基线；表、列、约束、索引、迁移、清理**以本文为准**
- 上游权威：`docs/00-product-decisions.md` v1.2（唯一权威；无服务器 / 数据只在本机 / 24h 物理删除 / 不做备份导出 / 计数允许超额不折叠）
- 字段语义：`docs/03-domain-model.md` §2（**字段名逐字一致**）；AI 落库映射：`docs/05-contracts/ai-json.md` 附录 B
- 技术前提：Tauri 2 + Rust + `rusqlite`（SQLite ≥ 3.38，需 JSON1，bundled 版本默认满足）+ WAL

> 设计原则：**只存产品定义里明确存在的数据**。没有原文、没有置信度、没有标签、没有提醒、没有软删除标记、没有备份表。24 小时后物理删除后不可找回（产品决策 v1.2 §7/D14）。

---

## 1. 存储边界（先明确不做什么）

| 不做 | 说明 |
|---|---|
| ❌ 备份 / 导出 / 导入 | `D14` 已推翻：不生成 `.bak`、不导出 JSON/Markdown、不提供恢复 API（见 §11） |
| ❌ 回收站 / 软删除 / 归档标记 | 只有未完成/已完成；已完成 24h 后 `DELETE`；删除不可恢复 |
| ❌ 原始语音/转写原文 / 解析置信度 / AI 假设 / batch_id | 产品决策 v1.2：除标题与字段外不引入其它字段；**原文不落库、不支持"重新解析"**（Q10 已确认） |
| ❌ 标签 / 清单 / 优先级 / 备注 / 提醒时间 | v1 无这些字段 |
| ❌ 密钥 / 激活码明文 | Key 存 Windows 凭据管理器（DPAPI），DB 不存（见 04-architecture） |
| ❌ 遥测 / 账号 / 设备 ID / 同步字段 | 无服务器、单机；不预留 `device_id`/`deleted_at`/`updated_at` |
| ❌ 多用户 / 权限 | 单用户单进程单库 |

- 数据库位置：Tauri 应用数据目录（`%APPDATA%\Clarify\clarify.sqlite3`，最终路径由 04-architecture 定）；数据库、WAL、SHM 三文件同目录。
- 单写者：应用内所有写操作经统一的 DB 层串行化；WAL 允许多读连接。禁止其它进程写库。

---

## 2. 连接与 PRAGMA

每个连接打开后（`journal_mode` 是持久设置，只需成功设置一次；其余逐连接设置）：

```sql
PRAGMA journal_mode = WAL;        -- 持久；崩溃恢复与读写并发
PRAGMA synchronous = NORMAL;      -- WAL 下的推荐值；掉电极端情况可能丢最后若干事务
PRAGMA foreign_keys = ON;         -- 必须逐连接开启（默认关闭）
PRAGMA busy_timeout = 5000;       -- 写锁等待 5s
PRAGMA wal_autocheckpoint = 1000; -- 默认值，显式记录
```

- 干净退出时执行 `PRAGMA wal_checkpoint(TRUNCATE);`（可选，减小 `-wal` 文件）。
- **不自动 `VACUUM`**：物理删除后的页由 SQLite 复用，文件不缩小是可接受的；无备份/导出，缩小无收益。维护性 VACUUM 属 P2（未定义前不做）。
- 启动时最多每 7 天跑一次 `PRAGMA quick_check;`，结果只写本地日志（不含内容），不阻塞启动（可选实现，见 §15）。

---

## 3. Schema 版本与迁移机制

### 3.1 版本标识

| 机制 | 规则 |
|---|---|
| `PRAGMA user_version` | **权威 schema 版本**。基线后 = `1`；每次迁移 +1 |
| `schema_migrations` 表 | 审计表：已应用版本、时间、描述；与 `user_version` 必须一致 |
| 应用支持范围 | 当前只支持 `user_version = 1`；未来支持 `[1, N]` |
| 只进不退 | **不支持降级**（down migration）；`user_version > 应用支持上限` → 拒绝启动并提示升级应用（只读，不改库） |

### 3.2 启动流程（必须按顺序）

1. 打开连接，设置 §2 PRAGMA（`journal_mode=WAL` 失败 → 报错退出，不降级到其它模式继续写）。
2. 读 `PRAGMA user_version`：
   - `0`（全新库）→ 在一个事务内执行 `0001_init.sql`，提交后 `user_version=1`；
   - `1`（当前）→ 正常打开；
   - `2..N` → 按序执行迁移（每个迁移自己一个事务；执行器由 04-architecture/08-engineering 指定，行为规则见下）；
   - `> N` → **拒绝启动**，提示"数据库由更高版本创建"，不做任何写入。
3. 迁移失败 → 事务回滚 → 应用不启动/只读报错；**不创建备份副本**（无备份策略），错误信息不含用户内容。
4. 迁移成功后可选 `PRAGMA foreign_key_check;`，非空则按数据损坏处理（§15）。
5. 启动后触发一次清理作业（§9）。

### 3.3 迁移文件规范

- 路径：`src-tauri/migrations/NNNN_name.sql`，四位递增（`0002_add_xxx.sql`）。
- 每个文件：`BEGIN IMMEDIATE; ... PRAGMA user_version = N; INSERT INTO schema_migrations ...; COMMIT;`；一个文件只做一次版本升级。
- **前向兼容**：只允许新增表/列/索引或数据搬移；改列类型/删列/改约束必须用 SQLite 12 步表重建法（新表→`INSERT SELECT`→`DROP`→`RENAME`→重建索引），并在迁移文件内完成。
- 迁移必须可在**已有数据**的库上重复演练（测试要求见 §15）。
- 迁移与代码同 PR 评审；破坏性变更需在 `10-risks-decisions.md` 登记。

### 3.4 迁移基线与 schema_version

| 版本 | 内容 | 状态 |
|---|---|---|
| `1` | 本契约全部表/索引/约束（`0001_init.sql`） | 本文件定义，冻结 |

---

## 4. 基线 DDL（`0001_init.sql`，已在 SQLite 3.42.0 实测通过）

> 连接 PRAGMA（§2）在脚本外设置；本脚本整体在一个 `BEGIN IMMEDIATE...COMMIT` 事务内执行。

```sql
-- Clarify baseline schema v1 (0001_init), applied inside a transaction.
BEGIN IMMEDIATE;

CREATE TABLE events (
    id                  TEXT    PRIMARY KEY NOT NULL
                                CHECK (length(id) = 36),
    title               TEXT    NOT NULL
                                CHECK (length(trim(title)) BETWEEN 1 AND 120
                                       AND instr(title, char(10)) = 0
                                       AND instr(title, char(13)) = 0),
    due_date            TEXT    CHECK (due_date IS NULL
                                       OR (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                           AND date(due_date, '+0 days') IS due_date)),
    due_start_at        TEXT    CHECK (due_start_at IS NULL
                                       OR (due_start_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
                                           AND strftime('%Y-%m-%dT%H:%M:%SZ', due_start_at, '+0 seconds') IS due_start_at)),
    due_end_at          TEXT    CHECK (due_end_at IS NULL
                                       OR (due_end_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
                                           AND strftime('%Y-%m-%dT%H:%M:%SZ', due_end_at, '+0 seconds') IS due_end_at)),
    deadline_at         TEXT    CHECK (deadline_at IS NULL
                                       OR (deadline_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
                                           AND strftime('%Y-%m-%dT%H:%M:%SZ', deadline_at, '+0 seconds') IS deadline_at)),
    repeat_freq         TEXT    CHECK (repeat_freq IS NULL OR repeat_freq IN ('day', 'week', 'month')),
    repeat_interval     INTEGER CHECK (repeat_interval IS NULL OR repeat_interval BETWEEN 1 AND 99),
    repeat_weekdays     TEXT    CHECK (repeat_weekdays IS NULL
                                       OR (json_valid(repeat_weekdays)
                                           AND json_type(repeat_weekdays) = 'array')),
    count_target        INTEGER CHECK (count_target IS NULL OR count_target BETWEEN 1 AND 99999),
    count_period        TEXT    CHECK (count_period IS NULL OR count_period IN ('day', 'week')),
    -- 计数进度允许超过 target（如 4/3）：目标只是显示参照，不设上限
    count_progress      INTEGER NOT NULL DEFAULT 0
                                CHECK (count_progress >= 0),
    count_period_key    TEXT    CHECK (count_period_key IS NULL
                                       OR (count_period_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                           AND date(count_period_key, '+0 days') IS count_period_key)
                                       OR (count_period_key GLOB '[0-9][0-9][0-9][0-9]-W[0-9][0-9]'
                                           AND CAST(substr(count_period_key, 7, 2) AS INTEGER) BETWEEN 1 AND 53)),
    created_at          TEXT    NOT NULL
                                CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
                                       AND strftime('%Y-%m-%dT%H:%M:%SZ', created_at, '+0 seconds') IS created_at),
    completed_at        TEXT    CHECK (completed_at IS NULL
                                       OR (completed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
                                           AND strftime('%Y-%m-%dT%H:%M:%SZ', completed_at, '+0 seconds') IS completed_at)),

    CHECK (due_date IS NULL OR (due_start_at IS NULL AND due_end_at IS NULL AND deadline_at IS NULL)),
    CHECK (due_end_at IS NULL OR due_start_at IS NOT NULL),
    CHECK (deadline_at IS NULL OR (due_start_at IS NOT NULL AND due_end_at IS NOT NULL)),
    CHECK (due_end_at IS NULL OR due_end_at > due_start_at),
    CHECK (deadline_at IS NULL OR deadline_at > due_end_at),

    CHECK (repeat_freq IS NOT NULL OR (repeat_interval IS NULL AND repeat_weekdays IS NULL)),
    CHECK (repeat_freq IS NULL OR due_date IS NOT NULL OR due_start_at IS NOT NULL),
    CHECK (repeat_weekdays IS NULL OR repeat_freq = 'week'),

    CHECK (count_target IS NOT NULL OR (count_period IS NULL AND count_period_key IS NULL AND count_progress = 0)),
    CHECK (count_target IS NULL OR (count_period IS NOT NULL AND count_period_key IS NOT NULL)),
    CHECK (count_target IS NULL
           OR (due_date IS NULL AND due_start_at IS NULL AND due_end_at IS NULL AND deadline_at IS NULL)),
    CHECK (count_target IS NULL OR repeat_freq IS NULL),
    CHECK (count_period IS NULL
           OR (count_period = 'day' AND count_period_key GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
           OR (count_period = 'week' AND count_period_key GLOB '[0-9][0-9][0-9][0-9]-W[0-9][0-9]')),

    CHECK (completed_at IS NULL OR (repeat_freq IS NULL AND count_target IS NULL)),
    CHECK (completed_at IS NULL OR completed_at >= created_at)
);

CREATE INDEX idx_events_due_open
    ON events (due_date, due_start_at)
    WHERE completed_at IS NULL AND count_target IS NULL;

CREATE INDEX idx_events_untimed_open
    ON events (created_at)
    WHERE completed_at IS NULL
      AND due_date IS NULL AND due_start_at IS NULL AND count_target IS NULL;

CREATE INDEX idx_events_count
    ON events (count_period, count_period_key)
    WHERE count_target IS NOT NULL;

CREATE INDEX idx_events_done_purge
    ON events (completed_at)
    WHERE completed_at IS NOT NULL;

CREATE TABLE event_completions (
    id                      TEXT PRIMARY KEY NOT NULL
                                CHECK (length(id) = 36),
    event_id                TEXT NOT NULL
                                REFERENCES events (id) ON DELETE CASCADE,
    occurrence_due_date     TEXT CHECK (occurrence_due_date IS NULL
                                OR (occurrence_due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                    AND date(occurrence_due_date, '+0 days') IS occurrence_due_date)),
    occurrence_start_at     TEXT CHECK (occurrence_start_at IS NULL
                                OR (occurrence_start_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
                                    AND strftime('%Y-%m-%dT%H:%M:%SZ', occurrence_start_at, '+0 seconds') IS occurrence_start_at)),
    occurrence_end_at       TEXT CHECK (occurrence_end_at IS NULL
                                OR (occurrence_end_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
                                    AND strftime('%Y-%m-%dT%H:%M:%SZ', occurrence_end_at, '+0 seconds') IS occurrence_end_at)),
    occurrence_deadline_at  TEXT CHECK (occurrence_deadline_at IS NULL
                                OR (occurrence_deadline_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
                                    AND strftime('%Y-%m-%dT%H:%M:%SZ', occurrence_deadline_at, '+0 seconds') IS occurrence_deadline_at)),
    completed_at            TEXT NOT NULL
                                CHECK (completed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
                                       AND strftime('%Y-%m-%dT%H:%M:%SZ', completed_at, '+0 seconds') IS completed_at),
    CHECK (occurrence_due_date IS NOT NULL OR occurrence_start_at IS NOT NULL),
    CHECK (occurrence_due_date IS NULL
           OR (occurrence_start_at IS NULL AND occurrence_end_at IS NULL AND occurrence_deadline_at IS NULL)),
    CHECK (occurrence_end_at IS NULL OR occurrence_start_at IS NOT NULL),
    CHECK (occurrence_deadline_at IS NULL
           OR (occurrence_start_at IS NOT NULL AND occurrence_end_at IS NOT NULL)),
    CHECK (occurrence_end_at IS NULL OR occurrence_end_at > occurrence_start_at),
    CHECK (occurrence_deadline_at IS NULL OR occurrence_deadline_at > occurrence_end_at)
);

CREATE INDEX idx_completions_purge ON event_completions (completed_at);
CREATE INDEX idx_completions_event ON event_completions (event_id, completed_at DESC);

CREATE TABLE settings (
    key         TEXT PRIMARY KEY NOT NULL
                    CHECK (length(trim(key)) BETWEEN 1 AND 100),
    value       TEXT NOT NULL CHECK (json_valid(value)),
    updated_at  TEXT NOT NULL
                    CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
                           AND strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+0 seconds') IS updated_at)
);

CREATE TABLE schema_migrations (
    version     INTEGER PRIMARY KEY NOT NULL CHECK (version >= 1),
    applied_at  TEXT NOT NULL
                    CHECK (applied_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
                           AND strftime('%Y-%m-%dT%H:%M:%SZ', applied_at, '+0 seconds') IS applied_at),
    description TEXT NOT NULL
);

INSERT INTO schema_migrations (version, applied_at, description)
VALUES (1, '2026-11-01T00:00:00Z', '0001_init');

PRAGMA user_version = 1;

COMMIT;
```

> 说明：`date(x,'+0 days') IS x` 与 `strftime(...,'+0 seconds') IS x` 用于拒绝 `2026-02-30`、`25:00` 这类"格式对但日历非法"的值（SQLite 的 `date()` 对部分非法日不做归一化，必须用归一化后比对；`IS` 用于让 `NULL` 判为不通过）。该写法已在 SQLite 3.42.0 实测通过。

---

## 5. 表与列说明

### 5.1 `events`：唯一实体（与 `03-domain-model.md` §2 一一对应）

| 列 | 类型 | 约束摘要 | 说明 |
|---|---|---|---|
| `id` | TEXT PK | 长度 36 | UUID v7（应用生成） |
| `title` | TEXT | 非空、trim 后 1–120、无 `\n`/`\r` | 动作短语 |
| `due_date` | TEXT | `YYYY-MM-DD` 且日历合法；与其它时间列互斥 | 仅日期 |
| `due_start_at` | TEXT | UTC ISO、秒=00、日历合法 | 时刻 / 时段开始 |
| `due_end_at` | TEXT | 同上；`> due_start_at` | 时段结束 |
| `deadline_at` | TEXT | 同上；`> due_end_at`；必须同时有 start/end | 时段+截止 |
| `repeat_freq` | TEXT | `day`/`week`/`month`；要求有时间基准 | 重复频率 |
| `repeat_interval` | INTEGER | 1–99；无频率时必须 NULL | 间隔 |
| `repeat_weekdays` | TEXT | JSON 数组（`json_valid`）；仅 `week` 允许 | 规范化 `[1,3,5]` |
| `count_target` | INTEGER | 1–99999；与时间/重复互斥；目标仅作显示参照（`progress` 可超过它） | 计数目标 |
| `count_period` | TEXT | `day`/`week`；与 target 同生同灭 | 计数周期 |
| `count_progress` | INTEGER | 非空默认 0；`>= 0`；**允许超过 `count_target`（如 4/3），不设上限**；无 target 时=0 | 本周期进度 |
| `count_period_key` | TEXT | 日键或 ISO 周键；与 target 同生同灭 | 周期标识 |
| `created_at` | TEXT | 非空、UTC、日历合法 | 创建时间 |
| `completed_at` | TEXT | UTC、日历合法、`>= created_at`；仅单次/无时间型 | 完成时间 |

- `repeat_weekdays` 采用"规范化 JSON 文本"（如 `[1,3,5]`，升序去重），应用层负责元素 1–7 的完整校验；DB 层只校验 JSON 合法且为数组。
- 不存 `time_kind` / `shape` / `status` / `updated_at` / `deleted_at` / `device_id`：全部派生或不适用（见领域文档 §3）。

### 5.2 `event_completions`：周期型完成日志

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | TEXT PK | UUID v7 |
| `event_id` | TEXT NOT NULL | FK → `events(id)` `ON DELETE CASCADE` |
| `occurrence_due_date` | TEXT | 被完成那一次的日期型快照 |
| `occurrence_start_at` | TEXT | 时刻 / 时段开始快照 |
| `occurrence_end_at` | TEXT | 时段结束快照 |
| `occurrence_deadline_at` | TEXT | 截止快照 |
| `completed_at` | TEXT NOT NULL | 完成时间（决定 24h 折叠与清理） |

- 一条日志 = 周期系列"这一次"的完成记录；不存 title（标题以事件行为准）。
- 快照列组合必须符合领域文档的时间精度规则（date / datetime / range 三选一，实测已覆盖）。
- 日志**24 小时后物理删除**；不保留历史（无导出、无统计）。
- 只有周期型会写日志；单次型用 `events.completed_at`；计数型**没有完成态**，不写日志、不写 `completed_at`。

### 5.3 `settings`：键值配置（只存非敏感、非内容数据）

| 列 | 类型 | 说明 |
|---|---|---|
| `key` | TEXT PK | 点分命名，如 `ui.main.template`、`internal.last_cleanup_at` |
| `value` | TEXT NOT NULL | **合法 JSON 文本**（字符串/数字/对象均可，统一 `json_valid` 校验） |
| `updated_at` | TEXT NOT NULL | UTC ISO |

- 本契约只启用内部键：`internal.last_cleanup_at`（清理作业最后成功时间，ISO 字符串）。UI/AI 配置键由 `02-ux-spec.md` / `05-contracts/config-schema.md` 定义，存储层不预置。
- **禁止**写入 API Key、激活码、token、音频路径、用户正文。

### 5.4 `schema_migrations`：迁移审计

| 列 | 类型 | 说明 |
|---|---|---|
| `version` | INTEGER PK | 与 `user_version` 一致的迁移版本 |
| `applied_at` | TEXT NOT NULL | 应用时间（UTC ISO） |
| `description` | TEXT NOT NULL | 如 `0001_init` |

### 5.5 索引与查询对应

| 索引 | 服务的查询 |
|---|---|
| `idx_events_due_open` | 视图按时间取未完成事项（逾期/今天/以后）；`completed_at IS NULL AND count_target IS NULL` |
| `idx_events_untimed_open` | "无时间与打卡"组的无时间事项（计数走下一页索引） |
| `idx_events_count` | 计数型按周期批量重置 / 列表查询 |
| `idx_events_done_purge` | 24h 清理扫描单次/无时间型已完成 |
| `idx_completions_purge` | 24h 清理扫描完成日志 |
| `idx_completions_event` | 取某系列最新完成日志（恢复用）、级联删除 |

- 视图查询一律只读；排序由 SQL `ORDER BY` 或应用层稳定排序实现（规则见领域文档 §11.3），不得依赖隐式行序。

---

## 6. 约束分层：DB 层与应用层

| 层 | 负责 |
|---|---|
| DB CHECK（本契约 §4） | 字段互斥/顺序/格式/范围等**结构性不变量**；任何写入路径都无法绕过 |
| 应用层（Rust DB 模块） | 需业务语义的校验：UUID 生成、`repeat_weekdays` 元素升序去重、ISO 周键合法性（W01–W53 与年份一致性）、时间时区换算、重复推进算法、形态切换规则、已完成不可编辑/删除 |

- 应用层校验失败 → 返回结构化错误，不写库；DB CHECK 失败 → 视为程序 bug（记录日志，不含用户内容），回滚事务。
- **禁止**用"先写坏再修"的补偿方式；所有写操作都在事务内完成校验与写入。

---

## 7. 事务与写入不变量

| 操作 | 事务规则（`BEGIN IMMEDIATE`） |
|---|---|
| 完成单次/无时间型 | `UPDATE events SET completed_at=:now WHERE id=:id AND completed_at IS NULL AND repeat_freq IS NULL AND count_target IS NULL;` `changes()=0` → 幂等成功（已完成）或 404（不存在） |
| 完成周期型 | 1) 读事件并快照 occurrence；2) `INSERT event_completions`；3) `UPDATE events` 为下一次 occurrence。三步同一事务原子提交 |
| 恢复周期型 | 1) `SELECT ... WHERE event_id=:id ORDER BY completed_at DESC, id DESC LIMIT 1`；2) 最新日志 ≠ 目标 → 409；3) `DELETE` 该日志；4) `UPDATE events` 回快照。同一事务 |
| 计数 +1 | 1) 读计数事件；2) 若 `count_period_key <> 当前键` → 先复位为 0/当前键；3) `progress = progress + 1`（**不封顶，可超过 target**）；4) 写回。同一事务（读-改-写串行化） |
| 删除 | `DELETE FROM events WHERE id=:id`（日志随 FK 级联）；周期型"只删本次"不执行 DELETE，而是推进 occurrence（同完成周期型但不写日志） |
| 清理作业 | 见 §9，单事务多语句；幂等 |
| 迁移 | 每个迁移文件一个事务；失败整体回滚 |

- 时间戳由 Rust 用 `chrono`/`time` 生成 UTC ISO；**SQL 内不使用 `datetime('now')`/`strftime('now')` 计算业务时间**，避免 SQLite 本地时区二义性。
- 周期键（`YYYY-MM-DD` / `YYYY-Www`）由 Rust 按系统时区计算后作为参数传入，SQL 只做比较/更新。

---

## 8. 显示/读取不变量

- 读"未完成"一律 `WHERE completed_at IS NULL`；计数型**没有完成态**（`completed_at` 恒为 NULL），读路径只按当前周期键判定进度是否过期。
- 读"已完成折叠"：
  - 单次/无时间型：`completed_at > cutoff(now-24h)`；
  - 周期型：`event_completions.completed_at > cutoff`（join 事件取标题）；
  - 计数型：**不进入折叠**（即使 `progress >= target` 也不查、不展示为已完成）。
- 计数型在**读路径**也要按当前周期键判定：若 `count_period_key` 已过期，即使清理作业还没跑，也按"进度 0"展示（旧周期进度视为过期）；写路径（+1）先做懒复位。
- 所有视图只读不写；不得在读路径自动"顺手清理"（清理只由 §9 作业执行），避免读操作放大写锁。

---

## 9. 物理删除与清理作业

### 9.1 触发

- 应用启动成功后立即执行一次；
- 运行期间每 **60 分钟**执行一次（单飞互斥，上一轮未完成则跳过本轮）；
- 系统从睡眠/休眠恢复后补一次（若平台事件可用；不可用不阻塞）。

### 9.2 执行 SQL（参数由 Rust 计算）

```sql
-- 参数：
--   :cutoff_utc  = now(UTC) - 24h，ISO UTC 字符串（如 2026-11-02T08:30:00Z）
--   :day_key     = 当前本地日键（如 2026-11-02）
--   :week_key    = 当前本地 ISO 周键（如 2026-W45）
--   :now_iso、:now 用于内部时间戳
BEGIN IMMEDIATE;

-- 1) 周期完成日志：超过 24h 物理删除
DELETE FROM event_completions
 WHERE completed_at <= :cutoff_utc;

-- 2) 单次/无时间型：已完成超过 24h 物理删除
--    （event_completions 由外键 ON DELETE CASCADE 一并清理）
DELETE FROM events
 WHERE completed_at IS NOT NULL
   AND completed_at <= :cutoff_utc;

-- 3) 计数周期复位（日）——只复位进度，不删除计数事件
UPDATE events
   SET count_progress = 0,
       count_period_key = :day_key
 WHERE count_target IS NOT NULL
   AND count_period = 'day'
   AND count_period_key <> :day_key;

-- 4) 计数周期复位（周）——只复位进度，不删除计数事件
UPDATE events
   SET count_progress = 0,
       count_period_key = :week_key
 WHERE count_target IS NOT NULL
   AND count_period = 'week'
   AND count_period_key <> :week_key;

-- 5) 记录本次成功执行时间（内部键；不涉及用户内容）
INSERT INTO settings (key, value, updated_at)
VALUES ('internal.last_cleanup_at', :now_json, :now_iso)
ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;

COMMIT;
```

（周键格式固定为 `YYYY-Www`，ISO 8601，周一为周首，见领域文档 §8.3。）

### 9.3 规则

- **只删**：完成的单次/无时间型事件行、超过 24h 的周期完成日志。
- **绝不删**：周期事件行、计数事件行、未完成事项、设置、迁移记录。
- **计数型无 24h 删除**：没有完成态/完成日志，达标或超额都不删除、不进折叠；仅在周期边界复位 `count_progress`。
- 幂等：重复执行结果一致；删除 0 行也视为成功并更新时间戳。
- 失败：回滚，本轮放弃；下轮重试；错误日志只含错误类型与行数，不含内容。连续失败在 UI 中弱提示（如"清理失败，稍后重试"），不阻塞用户操作。
- 与界面同一阈值：`completed_at + 24h`；界面隐藏即数据已/将删除，不存在"隐藏但保留"的软删除。

### 9.4 物理删除不可恢复

- 无回收站、无撤销、无备份、无导出（产品决策 v1.2 §7；D14 已推翻）。
- 用户主动删除（详情抽屉）立即 `DELETE`，同样不可恢复。
- 数据库文件损坏/被误删 → 数据丢失，无兜底（风险 R6，已在 `10-risks-decisions.md` 接受；v1.2 明确不做备份）。

---

## 10. 时区、时间格式与周期键

| 项 | 规则 |
|---|---|
| 时刻存储 | 一律 UTC，`YYYY-MM-DDTHH:MM:SSZ`，秒固定 `00` |
| 日期存储 | `due_date` = 本地日历日 `YYYY-MM-DD`，不做时区换算 |
| 周键 | ISO 8601：`YYYY-Www`，周一为周首，`2026-11-01` → `2026-W44` |
| 周期键生成 | Rust 按系统时区（IANA）从 `now` 计算；SQL 只比较/更新 |
| 时区变更 | 不重算已存 UTC 时刻；计数在下次读写时按新时区重新判定周期键（可能触发一次重置） |
| 时钟回拨 | 写完成时间用 `max(now, created_at)`；DB 约束 `completed_at >= created_at` 兜底 |
| 时钟前跳 | 24h 清理按新 `now` 判定，可能提前执行；接受（单机、无同步） |

---

## 11. 无备份、无导出、无恢复（明确契约）

- 本契约不定义任何备份/导出/导入/恢复 API、表、文件或脚本；应用不得在磁盘上生成数据库副本（`.bak`/快照/导出 JSON）。
- 迁移前不创建备份；迁移失败靠"事务回滚 + 拒绝启动"保证一致性，而不是副本。
- 数据安全的唯一保障：本机 SQLite 文件自身 + 用户自行管理的系统级备份（应用不感知、不承诺）。
- 该决定的后果由 `00-product-decisions.md` v1.2 与 `10-risks-decisions.md`（D14/R6）承担；本文只保证实现不偷偷提供软删除/回收站。

---

## 12. 容量与性能估算

| 项 | 估算 |
|---|---|
| 单行 `events` | 约 0.3–0.8 KB（含标题与 5 个时间戳/字段） |
| 1 万条事项 | 约 5–10 MB（含索引） |
| 10 万条事项 | 约 50–100 MB；单机可接受 |
| 完成日志 | 仅存活 ≤24h，数量有界（周期任务每天最多几十条） |
| 典型查询 | 视图查询 < 5 ms（万级数据 + 索引）；写操作 < 2 ms |
| 清理作业 | 每小时一次，扫描走部分索引；万级数据 < 10 ms |

- 无备份/导出意味着**不会**出现"导出大文件"类长事务；清理作业短事务即可。

---

## 13. 开发种子数据（仅 dev，禁止进生产初始化）

```sql
-- 仅用于本地开发/手动测试；生产启动不得插入示例数据
INSERT INTO events (id, title, due_start_at, created_at)
VALUES ('00000000-0000-7000-8000-000000000001', '跟张总开会',
        '2026-11-02T07:00:00Z', '2026-11-01T08:30:00Z');

INSERT INTO events (id, title, due_date, repeat_freq, repeat_interval, repeat_weekdays, created_at)
VALUES ('00000000-0000-7000-8000-000000000002', '陪家人',
        '2026-11-07', 'week', 1, '[6]', '2026-11-01T08:30:00Z');

INSERT INTO events (id, title, count_target, count_period, count_period_key, count_progress, created_at)
VALUES ('00000000-0000-7000-8000-000000000003', '喝水',
        3, 'day', '2026-11-01', 0, '2026-11-01T08:30:00Z');

INSERT INTO events (id, title, created_at)
VALUES ('00000000-0000-7000-8000-000000000004', '买牛奶', '2026-11-01T08:30:00Z');
```

---

## 14. 迁移与清理测试要求（验收）

1. **基线建库**：空目录首次启动 → `user_version=1`、6 个索引存在、`schema_migrations` 有 1 行。
2. **约束矩阵**：至少覆盖领域文档 §13.1 全部 C 编号（每类非法写入必须抛 `IntegrityError`，合法写入必须成功）；`events` 与 `event_completions` 的时间组合均测；**`count_progress > count_target`（如 4/3）必须写入成功**。
3. **级联**：删除周期事件 → 完成日志全部消失；删除单次事件 → 无残留。
4. **清理**：造 `completed_at = now-24h±1s` 的单次事件与日志，验证删除边界；计数跨日/跨周重置；重复执行幂等。
5. **恢复**：最新日志恢复成功、非最新日志拒绝（409 语义）、超 24h 拒绝。
6. **迁移**：从 v1 种子库升级到 v2 的演练（v2 出现前用临时迁移验证流程）；迁移失败必须整体回滚且 `user_version` 不变。
7. **降级拒绝**：手工把 `user_version` 设为 99 → 应用拒绝启动且不写库。
8. **WAL**：并发读 + 单写无 `SQLITE_BUSY` 泄漏；崩溃（kill -9）后重启库可打开、`quick_check` 通过。

---

## 15. 异常与损坏处理

| 情况 | 行为 |
|---|---|
| `PRAGMA integrity_check/quick_check` 失败 | 记录错误（无内容）→ 只读模式启动或提示"数据损坏，无法打开"；不做自动修复/重建（无备份策略，擅自重建=丢数据） |
| `SQLITE_BUSY` 超过 busy_timeout | 返回结构化错误，UI 提示重试；不重试写事务（避免非幂等重复） |
| 磁盘满 | 写失败回滚；提示清理磁盘；不静默丢弃 |
| 迁移版本高于应用 | 拒绝启动（见 §3.2） |
| `foreign_key_check` 非空 | 视为数据损坏，按上处理并记录 |

---

## 变更记录

| 版本 | 日期 | 变更 | 来源 |
|---|---|---|---|
| v1.0 | 2026-11-01 | 首版：events / event_completions / settings / schema_migrations；WAL；约束与索引；24h 物理清理；计数周期重置；无备份导出；schema 版本 1 | `00-product-decisions.md` v1.1 + `03-domain-model.md` |
| v1.1 | 2026-11-01 | 计数语义：允许 `count_progress > count_target`（移除上限 CHECK）、`+1` 不封顶；明确计数无完成态/无 24h 删除，清理 SQL 仅复位 | 用户确认（经 Lead） |
