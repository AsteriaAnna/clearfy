use crate::clock::{iso_utc, Clock};
use crate::model::{
    advance_repeat, count_period_key, validate, CoreError, Event, NewEvent,
};
use chrono::Duration;
use rusqlite::{params, Connection, OptionalExtension, Row};

pub struct Store {
    conn: Connection,
}

#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
pub struct PurgeResult {
    pub deleted_events: usize,
    pub deleted_completions: usize,
    pub reset_counts: usize,
}

const EVENT_COLS: &str = "id,title,due_date,due_start_at,due_end_at,deadline_at,repeat_freq,repeat_interval,repeat_weekdays,count_target,count_period,count_progress,count_period_key,created_at,completed_at";

impl Store {
    pub fn open(path: &str) -> Result<Self, CoreError> {
        let conn = Connection::open(path)?;
        Self::from_conn(conn)
    }

    pub fn open_in_memory() -> Result<Self, CoreError> {
        Self::from_conn(Connection::open_in_memory()?)
    }

    fn from_conn(conn: Connection) -> Result<Self, CoreError> {
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        let store = Self { conn };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&self) -> Result<(), CoreError> {
        self.conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS schema_migrations(
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS events(
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                due_date TEXT,
                due_start_at TEXT,
                due_end_at TEXT,
                deadline_at TEXT,
                repeat_freq TEXT,
                repeat_interval INTEGER,
                repeat_weekdays TEXT,
                count_target INTEGER,
                count_period TEXT,
                count_progress INTEGER NOT NULL DEFAULT 0,
                count_period_key TEXT,
                created_at TEXT NOT NULL,
                completed_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_events_completed ON events(completed_at);
            CREATE INDEX IF NOT EXISTS idx_events_due_date ON events(due_date);
            CREATE INDEX IF NOT EXISTS idx_events_due_start ON events(due_start_at);
            CREATE TABLE IF NOT EXISTS event_completions(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
                due_snapshot TEXT NOT NULL,
                completed_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_completions_event ON event_completions(event_id);
            CREATE INDEX IF NOT EXISTS idx_completions_time ON event_completions(completed_at);
            CREATE TABLE IF NOT EXISTS settings(
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
            "#,
        )?;
        Ok(())
    }

    pub fn create(&self, new: &NewEvent, clock: &dyn Clock) -> Result<Event, CoreError> {
        let title = validate(new)?;
        let id = uuid::Uuid::now_v7().to_string();
        let now = iso_utc(clock.now_utc());
        let repeat_interval = if new.repeat_freq.is_some() {
            Some(new.repeat_interval.unwrap_or(1))
        } else {
            None
        };
        let weekdays_json = new
            .repeat_weekdays
            .as_ref()
            .map(|d| serde_json::to_string(d).unwrap_or_default());
        let count_period = new.count_period.clone();
        let count_target = new.count_target;
        let count_period_key = count_period
            .as_deref()
            .map(|p| count_period_key(p, clock));
        self.conn.execute(
            "INSERT INTO events(id,title,due_date,due_start_at,due_end_at,deadline_at,repeat_freq,repeat_interval,repeat_weekdays,count_target,count_period,count_progress,count_period_key,created_at,completed_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,0,?12,?13,NULL)",
            params![
                id,
                title,
                new.due_date,
                new.due_start_at,
                new.due_end_at,
                new.deadline_at,
                new.repeat_freq,
                repeat_interval,
                weekdays_json,
                count_target,
                count_period,
                count_period_key,
                now,
            ],
        )?;
        self.get(&id)
    }

    pub fn get(&self, id: &str) -> Result<Event, CoreError> {
        self.conn
            .query_row(
                &format!("SELECT {EVENT_COLS} FROM events WHERE id = ?1"),
                params![id],
                row_to_event,
            )
            .optional()?
            .ok_or(CoreError::NotFound)
    }

    pub fn list_open(&self) -> Result<Vec<Event>, CoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {EVENT_COLS} FROM events WHERE completed_at IS NULL"
        ))?;
        let rows = stmt.query_map([], row_to_event)?;
        let mut out: Vec<Event> = rows.collect::<Result<_, _>>()?;
        out.sort_by_key(|e| e.sort_key());
        Ok(out)
    }

    pub fn list_completed(&self, clock: &dyn Clock) -> Result<Vec<Event>, CoreError> {
        let cutoff = iso_utc(clock.now_utc() - Duration::hours(24));
        let mut stmt = self.conn.prepare(&format!(
            "SELECT {EVENT_COLS} FROM events WHERE completed_at IS NOT NULL AND completed_at >= ?1 ORDER BY completed_at DESC"
        ))?;
        let rows = stmt.query_map(params![cutoff], row_to_event)?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// 完成单次/无时间事件；重复事件推进到下一次；计数任务不允许调用。
    pub fn complete(&self, id: &str, clock: &dyn Clock) -> Result<Event, CoreError> {
        let event = self.get(id)?;
        if event.is_count() {
            return Err(CoreError::CountNotCompletable);
        }
        if event.is_completed() {
            return Err(CoreError::AlreadyCompleted);
        }
        let now = iso_utc(clock.now_utc());
        if event.is_repeat() {
            let advance = advance_repeat(&event)?;
            self.conn.execute(
                "INSERT INTO event_completions(event_id, due_snapshot, completed_at) VALUES(?1,?2,?3)",
                params![id, advance.snapshot, now],
            )?;
            self.conn.execute(
                "UPDATE events SET due_date=?1, due_start_at=?2, due_end_at=?3, deadline_at=?4 WHERE id=?5",
                params![
                    advance.due_date,
                    advance.due_start_at,
                    advance.due_end_at,
                    advance.deadline_at,
                    id
                ],
            )?;
        } else {
            self.conn.execute(
                "UPDATE events SET completed_at=?1 WHERE id=?2",
                params![now, id],
            )?;
        }
        self.get(id)
    }

    /// 恢复：单次/无时间清 completed_at；重复任务恢复最近一次完成（回退到快照）。
    pub fn restore(&self, id: &str) -> Result<Event, CoreError> {
        let event = self.get(id)?;
        if event.is_completed() {
            self.conn.execute(
                "UPDATE events SET completed_at=NULL WHERE id=?1",
                params![id],
            )?;
            return self.get(id);
        }
        if event.is_repeat() {
            let last: Option<(i64, String)> = self
                .conn
                .query_row(
                    "SELECT id, due_snapshot FROM event_completions WHERE event_id=?1 ORDER BY completed_at DESC, id DESC LIMIT 1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((log_id, snapshot)) = last {
                let v: serde_json::Value =
                    serde_json::from_str(&snapshot).map_err(|_| CoreError::InvalidTime)?;
                self.conn.execute(
                    "UPDATE events SET due_date=?1, due_start_at=?2, due_end_at=?3, deadline_at=?4 WHERE id=?5",
                    params![
                        v["due_date"].as_str().map(str::to_string),
                        v["due_start_at"].as_str().map(str::to_string),
                        v["due_end_at"].as_str().map(str::to_string),
                        v["deadline_at"].as_str().map(str::to_string),
                        id
                    ],
                )?;
                self.conn
                    .execute("DELETE FROM event_completions WHERE id=?1", params![log_id])?;
                return self.get(id);
            }
        }
        Err(CoreError::NothingToRestore)
    }

    /// 计数 +1；允许超过目标；周期变化时先复位。返回最新事件。
    pub fn increment_count(&self, id: &str, clock: &dyn Clock) -> Result<Event, CoreError> {
        let event = self.get(id)?;
        let period = event.count_period.as_deref().ok_or(CoreError::InvalidCount)?;
        let key = count_period_key(period, clock);
        let mut progress = event.count_progress;
        if event.count_period_key.as_deref() != Some(key.as_str()) {
            progress = 0;
        }
        progress += 1;
        self.conn.execute(
            "UPDATE events SET count_progress=?1, count_period_key=?2 WHERE id=?3",
            params![progress, key, id],
        )?;
        self.get(id)
    }

    pub fn delete(&self, id: &str) -> Result<(), CoreError> {
        let n = self
            .conn
            .execute("DELETE FROM events WHERE id=?1", params![id])?;
        if n == 0 {
            return Err(CoreError::NotFound);
        }
        Ok(())
    }

    /// 24h 物理清理 + 计数周期复位（每次启动/定时调用）。
    pub fn purge(&self, clock: &dyn Clock) -> Result<PurgeResult, CoreError> {
        let cutoff = iso_utc(clock.now_utc() - Duration::hours(24));
        let deleted_events = self.conn.execute(
            "DELETE FROM events WHERE completed_at IS NOT NULL AND completed_at <= ?1",
            params![cutoff],
        )?;
        let deleted_completions = self.conn.execute(
            "DELETE FROM event_completions WHERE completed_at <= ?1",
            params![cutoff],
        )?;
        let mut reset_counts = 0usize;
        let mut stmt = self.conn.prepare(
            "SELECT id, count_period, count_period_key FROM events WHERE count_target IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?;
        for row in rows {
            let (id, period, stored_key) = row?;
            let Some(period) = period else { continue };
            let key = count_period_key(&period, clock);
            if stored_key.as_deref() != Some(key.as_str()) {
                self.conn.execute(
                    "UPDATE events SET count_progress=0, count_period_key=?1 WHERE id=?2",
                    params![key, id],
                )?;
                reset_counts += 1;
            }
        }
        Ok(PurgeResult {
            deleted_events,
            deleted_completions,
            reset_counts,
        })
    }

    pub fn completion_count(&self, id: &str) -> Result<i64, CoreError> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM event_completions WHERE event_id=?1",
            params![id],
            |r| r.get(0),
        )?;
        Ok(n)
    }
}

fn row_to_event(row: &Row<'_>) -> rusqlite::Result<Event> {
    let weekdays_json: Option<String> = row.get(8)?;
    let repeat_weekdays = weekdays_json.and_then(|s| serde_json::from_str::<Vec<i64>>(&s).ok());
    Ok(Event {
        id: row.get(0)?,
        title: row.get(1)?,
        due_date: row.get(2)?,
        due_start_at: row.get(3)?,
        due_end_at: row.get(4)?,
        deadline_at: row.get(5)?,
        repeat_freq: row.get(6)?,
        repeat_interval: row.get(7)?,
        repeat_weekdays,
        count_target: row.get(9)?,
        count_period: row.get(10)?,
        count_progress: row.get(11)?,
        count_period_key: row.get(12)?,
        created_at: row.get(13)?,
        completed_at: row.get(14)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::FixedClock;
    use chrono::{NaiveDate, TimeZone, Utc};

    fn clock_at(date: &str) -> FixedClock {
        let today = NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap();
        let now = Utc
            .with_ymd_and_hms(today.year(), today.month(), today.day(), 7, 0, 0)
            .unwrap();
        FixedClock::new(now, today)
    }

    use chrono::Datelike;

    fn count_event(target: i64, period: &str, title: &str) -> NewEvent {
        NewEvent {
            title: title.to_string(),
            count_target: Some(target),
            count_period: Some(period.to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn rejects_count_with_time() {
        let mut e = count_event(3, "day", "喝水");
        e.due_date = Some("2026-11-02".to_string());
        assert_eq!(validate(&e).unwrap_err(), CoreError::CountConflict);
    }

    #[test]
    fn rejects_repeat_without_anchor() {
        let e = NewEvent {
            title: "组会".to_string(),
            repeat_freq: Some("week".to_string()),
            ..Default::default()
        };
        assert_eq!(validate(&e).unwrap_err(), CoreError::RepeatWithoutAnchor);
    }

    #[test]
    fn count_allows_overshoot_and_resets_at_boundary() {
        let mut clock = clock_at("2026-11-01");
        let store = Store::open_in_memory().unwrap();
        let ev = store.create(&count_event(3, "day", "喝水"), &clock).unwrap();
        for expected in 1..=4 {
            let updated = store.increment_count(&ev.id, &clock).unwrap();
            assert_eq!(updated.count_progress, expected);
        }
        assert_eq!(store.get(&ev.id).unwrap().count_progress, 4);
        clock.advance_days(1);
        let updated = store.increment_count(&ev.id, &clock).unwrap();
        assert_eq!(updated.count_progress, 1);
        assert_eq!(updated.completed_at, None);
    }

    #[test]
    fn single_complete_and_restore() {
        let clock = clock_at("2026-11-01");
        let store = Store::open_in_memory().unwrap();
        let ev = store
            .create(
                &NewEvent {
                    title: "交周报".to_string(),
                    due_start_at: Some("2026-11-01T03:00:00Z".to_string()),
                    ..Default::default()
                },
                &clock,
            )
            .unwrap();
        let done = store.complete(&ev.id, &clock).unwrap();
        assert!(done.is_completed());
        assert_eq!(store.list_open().unwrap().len(), 0);
        assert_eq!(store.list_completed(&clock).unwrap().len(), 1);
        let restored = store.restore(&ev.id).unwrap();
        assert!(!restored.is_completed());
    }

    #[test]
    fn repeat_advances_without_completing_series() {
        let clock = clock_at("2026-11-01");
        let store = Store::open_in_memory().unwrap();
        let ev = store
            .create(
                &NewEvent {
                    title: "组会".to_string(),
                    due_date: Some("2026-11-02".to_string()),
                    repeat_freq: Some("week".to_string()),
                    repeat_interval: Some(1),
                    ..Default::default()
                },
                &clock,
            )
            .unwrap();
        let updated = store.complete(&ev.id, &clock).unwrap();
        assert_eq!(updated.completed_at, None);
        assert_eq!(updated.due_date.as_deref(), Some("2026-11-09"));
        assert_eq!(store.completion_count(&ev.id).unwrap(), 1);
        let restored = store.restore(&ev.id).unwrap();
        assert_eq!(restored.due_date.as_deref(), Some("2026-11-02"));
        assert_eq!(store.completion_count(&ev.id).unwrap(), 0);
    }

    #[test]
    fn purge_removes_completed_after_24h() {
        let mut clock = clock_at("2026-11-01");
        let store = Store::open_in_memory().unwrap();
        let ev = store
            .create(
                &NewEvent {
                    title: "买牛奶".to_string(),
                    ..Default::default()
                },
                &clock,
            )
            .unwrap();
        store.complete(&ev.id, &clock).unwrap();
        clock.advance_days(2);
        let result = store.purge(&clock).unwrap();
        assert_eq!(result.deleted_events, 1);
        assert!(store.get(&ev.id).is_err());
    }

    #[test]
    fn count_never_purged_only_reset() {
        let mut clock = clock_at("2026-11-01");
        let store = Store::open_in_memory().unwrap();
        let ev = store.create(&count_event(3, "day", "喝水"), &clock).unwrap();
        store.increment_count(&ev.id, &clock).unwrap();
        clock.advance_days(1);
        let result = store.purge(&clock).unwrap();
        assert_eq!(result.deleted_events, 0);
        assert_eq!(result.reset_counts, 1);
        let after = store.get(&ev.id).unwrap();
        assert_eq!(after.count_progress, 0);
    }
}
