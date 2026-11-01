use crate::clock::{iso_utc, parse_utc, Clock};
use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};

#[derive(thiserror::Error, Debug, PartialEq)]
pub enum CoreError {
    #[error("标题必须是 1..=120 个字符")]
    InvalidTitle,
    #[error("时间字段组合非法")]
    InvalidTime,
    #[error("重复规则必须有时间基准")]
    RepeatWithoutAnchor,
    #[error("计数字段与时间/重复不能共存")]
    CountConflict,
    #[error("计数字段非法")]
    InvalidCount,
    #[error("事件不存在")]
    NotFound,
    #[error("计数任务没有完成态，请使用 +1")]
    CountNotCompletable,
    #[error("事件已完成")]
    AlreadyCompleted,
    #[error("没有可恢复的完成记录")]
    NothingToRestore,
    #[error("数据库错误: {0}")]
    Db(String),
}

impl From<rusqlite::Error> for CoreError {
    fn from(e: rusqlite::Error) -> Self {
        CoreError::Db(e.to_string())
    }
}

/// 新建事件输入（不含系统字段）。空 Option = 用户没说。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NewEvent {
    pub title: String,
    pub due_date: Option<String>,
    pub due_start_at: Option<String>,
    pub due_end_at: Option<String>,
    pub deadline_at: Option<String>,
    pub repeat_freq: Option<String>,
    pub repeat_interval: Option<i64>,
    pub repeat_weekdays: Option<Vec<i64>>,
    pub count_target: Option<i64>,
    pub count_period: Option<String>,
}

/// 持久化事件。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub id: String,
    pub title: String,
    pub due_date: Option<String>,
    pub due_start_at: Option<String>,
    pub due_end_at: Option<String>,
    pub deadline_at: Option<String>,
    pub repeat_freq: Option<String>,
    pub repeat_interval: Option<i64>,
    pub repeat_weekdays: Option<Vec<i64>>,
    pub count_target: Option<i64>,
    pub count_period: Option<String>,
    pub count_progress: i64,
    pub count_period_key: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

impl Event {
    pub fn is_count(&self) -> bool {
        self.count_target.is_some()
    }
    pub fn is_repeat(&self) -> bool {
        self.repeat_freq.is_some()
    }
    pub fn is_completed(&self) -> bool {
        self.completed_at.is_some()
    }
    /// 用于视图排序：日期优先，其次时刻，空值最后。
    pub fn sort_key(&self) -> String {
        let date = self
            .due_date
            .clone()
            .or_else(|| self.due_start_at.as_ref().map(|s| s[..10].to_string()))
            .unwrap_or_else(|| "9999-12-31".to_string());
        let time = self.due_start_at.clone().unwrap_or_default();
        format!("{date}|{time}|{}", self.created_at)
    }
}

fn is_valid_date(s: &str) -> bool {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

/// 校验 NewEvent 内部一致性；返回 trim 后的标题。
pub fn validate(new: &NewEvent) -> Result<String, CoreError> {
    let title = new.title.trim().to_string();
    if title.is_empty() || title.chars().count() > 120 {
        return Err(CoreError::InvalidTitle);
    }
    if let Some(d) = &new.due_date {
        if !is_valid_date(d) || new.due_start_at.is_some() {
            return Err(CoreError::InvalidTime);
        }
    }
    if new.due_end_at.is_some() && new.due_start_at.is_none() {
        return Err(CoreError::InvalidTime);
    }
    if let Some(s) = &new.due_start_at {
        if parse_utc(s).is_none() {
            return Err(CoreError::InvalidTime);
        }
    }
    if let Some(e) = &new.due_end_at {
        let start = new
            .due_start_at
            .as_ref()
            .and_then(|s| parse_utc(s))
            .ok_or(CoreError::InvalidTime)?;
        let end = parse_utc(e).ok_or(CoreError::InvalidTime)?;
        if end <= start {
            return Err(CoreError::InvalidTime);
        }
    }
    if let Some(d) = &new.deadline_at {
        let start = new
            .due_start_at
            .as_ref()
            .and_then(|s| parse_utc(s))
            .ok_or(CoreError::InvalidTime)?;
        let end = new
            .due_end_at
            .as_ref()
            .and_then(|s| parse_utc(s))
            .ok_or(CoreError::InvalidTime)?;
        let deadline = parse_utc(d).ok_or(CoreError::InvalidTime)?;
        let _ = start;
        if deadline <= end {
            return Err(CoreError::InvalidTime);
        }
    }
    let has_count = new.count_target.is_some() || new.count_period.is_some();
    if has_count {
        if new.count_target.is_none() || new.count_period.is_none() {
            return Err(CoreError::InvalidCount);
        }
        if new.due_date.is_some()
            || new.due_start_at.is_some()
            || new.repeat_freq.is_some()
            || new.deadline_at.is_some()
        {
            return Err(CoreError::CountConflict);
        }
        let target = new.count_target.unwrap_or(0);
        if !(1..=99_999).contains(&target) {
            return Err(CoreError::InvalidCount);
        }
        if !matches!(new.count_period.as_deref(), Some("day") | Some("week")) {
            return Err(CoreError::InvalidCount);
        }
    } else if new.repeat_freq.is_none() && new.count_period.is_some() {
        return Err(CoreError::InvalidCount);
    }
    if let Some(freq) = &new.repeat_freq {
        if !matches!(freq.as_str(), "day" | "week" | "month") {
            return Err(CoreError::RepeatWithoutAnchor);
        }
        if new.due_date.is_none() && new.due_start_at.is_none() {
            return Err(CoreError::RepeatWithoutAnchor);
        }
        let interval = new.repeat_interval.unwrap_or(1);
        if !(1..=99).contains(&interval) {
            return Err(CoreError::RepeatWithoutAnchor);
        }
        if let Some(days) = &new.repeat_weekdays {
            if freq != "week" || days.is_empty() {
                return Err(CoreError::RepeatWithoutAnchor);
            }
            let mut sorted = days.clone();
            sorted.sort_unstable();
            sorted.dedup();
            if sorted.len() != days.len() || sorted.iter().any(|d| !(1..=7).contains(d)) {
                return Err(CoreError::RepeatWithoutAnchor);
            }
        }
    } else if new.repeat_weekdays.is_some() || new.repeat_interval.is_some() {
        return Err(CoreError::RepeatWithoutAnchor);
    }
    Ok(title)
}

/// 计数周期键（日=YYYY-MM-DD，周=YYYY-Www）。
pub fn count_period_key(period: &str, clock: &dyn Clock) -> String {
    match period {
        "week" => clock.local_week_key(),
        _ => clock.local_date().format("%Y-%m-%d").to_string(),
    }
}

/// 重复事件完成一次后的下一次（返回旧字段快照 JSON 与新字段）。
pub struct RepeatAdvance {
    pub snapshot: String,
    pub due_date: Option<String>,
    pub due_start_at: Option<String>,
    pub due_end_at: Option<String>,
    pub deadline_at: Option<String>,
}

pub fn advance_repeat(event: &Event) -> Result<RepeatAdvance, CoreError> {
    let freq = event.repeat_freq.as_deref().ok_or(CoreError::InvalidTime)?;
    let interval = event.repeat_interval.unwrap_or(1).max(1);
    let weekdays = event.repeat_weekdays.clone().unwrap_or_default();
    let snapshot = serde_json::json!({
        "due_date": event.due_date,
        "due_start_at": event.due_start_at,
        "due_end_at": event.due_end_at,
        "deadline_at": event.deadline_at,
    })
    .to_string();

    if let Some(d) = &event.due_date {
        let date = NaiveDate::parse_from_str(d, "%Y-%m-%d").map_err(|_| CoreError::InvalidTime)?;
        let next = next_date(date, freq, interval, &weekdays).ok_or(CoreError::InvalidTime)?;
        return Ok(RepeatAdvance {
            snapshot,
            due_date: Some(next.format("%Y-%m-%d").to_string()),
            due_start_at: None,
            due_end_at: None,
            deadline_at: None,
        });
    }

    let start = parse_utc(event.due_start_at.as_deref().unwrap_or_default())
        .ok_or(CoreError::InvalidTime)?;
    let next_start = shift_utc(start, freq, interval).ok_or(CoreError::InvalidTime)?;
    let next_end = match &event.due_end_at {
        Some(e) => shift_utc(parse_utc(e).ok_or(CoreError::InvalidTime)?, freq, interval),
        None => None,
    };
    let next_deadline = match &event.deadline_at {
        Some(d) => shift_utc(parse_utc(d).ok_or(CoreError::InvalidTime)?, freq, interval),
        None => None,
    };
    Ok(RepeatAdvance {
        snapshot,
        due_date: None,
        due_start_at: Some(iso_utc(next_start)),
        due_end_at: next_end.map(iso_utc),
        deadline_at: next_deadline.map(iso_utc),
    })
}

fn next_date(
    date: NaiveDate,
    freq: &str,
    interval: i64,
    weekdays: &[i64],
) -> Option<NaiveDate> {
    match freq {
        "day" => date.checked_add_signed(chrono::Duration::days(interval)),
        "week" => {
            if !weekdays.is_empty() {
                let mut cur = date.checked_add_signed(chrono::Duration::days(1))?;
                for _ in 0..14 {
                    let wd = cur.weekday().num_days_from_monday() as i64 + 1;
                    if weekdays.contains(&wd) {
                        return Some(cur);
                    }
                    cur = cur.checked_add_signed(chrono::Duration::days(1))?;
                }
                date.checked_add_signed(chrono::Duration::days(7 * interval))
            } else {
                date.checked_add_signed(chrono::Duration::days(7 * interval))
            }
        }
        "month" => date.checked_add_months(chrono::Months::new(interval as u32)),
        _ => None,
    }
}

fn shift_utc(dt: chrono::DateTime<chrono::Utc>, freq: &str, interval: i64) -> Option<chrono::DateTime<chrono::Utc>> {
    match freq {
        "day" => Some(dt + chrono::Duration::days(interval)),
        "week" => Some(dt + chrono::Duration::days(7 * interval)),
        "month" => dt.checked_add_months(chrono::Months::new(interval as u32)),
        _ => None,
    }
}
