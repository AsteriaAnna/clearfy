use chrono::{DateTime, Datelike, Local, NaiveDate, Utc};

/// 业务时间统一从这里取；禁止模块内直接调用 SystemTime/Utc::now/Local::now。
pub trait Clock: Send + Sync {
    fn now_utc(&self) -> DateTime<Utc>;
    fn local_date(&self) -> NaiveDate;
    fn local_week_key(&self) -> String;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_utc(&self) -> DateTime<Utc> {
        Utc::now()
    }
    fn local_date(&self) -> NaiveDate {
        Local::now().date_naive()
    }
    fn local_week_key(&self) -> String {
        week_key(self.local_date())
    }
}

/// 测试用可推进时钟。
#[derive(Debug, Clone)]
pub struct FixedClock {
    now: DateTime<Utc>,
    today: NaiveDate,
}

impl FixedClock {
    pub fn new(now: DateTime<Utc>, today: NaiveDate) -> Self {
        Self { now, today }
    }
    pub fn advance_days(&mut self, days: i64) {
        self.now += chrono::Duration::days(days);
        self.today += chrono::Duration::days(days);
    }
}

impl Clock for FixedClock {
    fn now_utc(&self) -> DateTime<Utc> {
        self.now
    }
    fn local_date(&self) -> NaiveDate {
        self.today
    }
    fn local_week_key(&self) -> String {
        week_key(self.today)
    }
}

pub fn week_key(d: NaiveDate) -> String {
    let iso = d.iso_week();
    format!("{}-W{:02}", iso.year(), iso.week())
}

pub fn iso_utc(dt: DateTime<Utc>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub fn parse_utc(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}
