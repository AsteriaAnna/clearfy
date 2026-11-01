//! 规则模式解析：无 AI/离线时的兜底。只解析明确说出的时间与计数，不猜。
//! 口径：docs/03-domain-model.md / docs/05-contracts/ai-json.md §7。

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};

use crate::model::NewEvent;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ParsedItem {
    pub event: NewEvent,
    pub confidence: f64,
    pub rule: String,
}

fn weekday_index(c: char) -> Option<i64> {
    match c {
        '一' => Some(1),
        '二' => Some(2),
        '三' => Some(3),
        '四' => Some(4),
        '五' => Some(5),
        '六' => Some(6),
        '日' | '天' => Some(7),
        _ => None,
    }
}

fn next_weekday(from: NaiveDate, target: i64) -> NaiveDate {
    let cur = i64::from(from.weekday().num_days_from_monday()) + 1;
    let diff = if target > cur { target - cur } else { 7 - cur + target };
    from + Duration::days(diff)
}

fn chinese_number(s: &str) -> Option<i64> {
    if let Ok(n) = s.parse::<i64>() {
        return Some(n);
    }
    let mut total = 0i64;
    let mut current = 0i64;
    for c in s.chars() {
        match c {
            '一' => current = 1,
            '二' | '两' => current = 2,
            '三' => current = 3,
            '四' => current = 4,
            '五' => current = 5,
            '六' => current = 6,
            '七' => current = 7,
            '八' => current = 8,
            '九' => current = 9,
            '十' => {
                let base = if current == 0 { 1 } else { current };
                total += base * 10;
                current = 0;
            }
            _ => return None,
        }
    }
    Some(total + current)
}

fn find_time_of_day(seg: &str) -> Option<(i64, i64, usize, usize)> {
    // 返回 (hour, minute, start_char, end_char)
    let chars: Vec<char> = seg.chars().collect();
    let mut period_hour: Option<i64> = None;
    let mut period_end = 0usize;
    for (i, w) in ["上午", "早上", "中午", "下午", "晚上", "傍晚"].iter().enumerate() {
        if let Some(pos) = seg.find(w) {
            let _ = i;
            period_hour = Some(match *w {
                "上午" | "早上" => 9,
                "中午" => 12,
                "下午" => 15,
                "晚上" | "傍晚" => 20,
                _ => 9,
            });
            period_end = seg[..pos].chars().count() + w.chars().count();
            break;
        }
    }
    // 支持 "10:00" / "10：00"
    {
        let mut i = 0usize;
        while i + 2 < chars.len() {
            if chars[i].is_ascii_digit() {
                let start = i;
                let mut j = i;
                while j < chars.len() && chars[j].is_ascii_digit() {
                    j += 1;
                }
                if j < chars.len() && (chars[j] == ':' || chars[j] == '：') {
                    let mut k = j + 1;
                    while k < chars.len() && chars[k].is_ascii_digit() {
                        k += 1;
                    }
                    if k > j + 1 {
                        let hs: String = chars[start..j].iter().collect();
                        let ms: String = chars[j + 1..k].iter().collect();
                        if let (Ok(mut h), Ok(m)) = (hs.parse::<i64>(), ms.parse::<i64>()) {
                            if period_hour.is_some() && h < 12 && (seg.contains("下午") || seg.contains("晚上") || seg.contains("傍晚")) {
                                h += 12;
                            }
                            if (0..24).contains(&h) && (0..60).contains(&m) {
                                return Some((h, m, start, k));
                            }
                        }
                    }
                }
            }
            i += 1;
        }
    }

    // 找 “N点(半|N分)?”
    let mut num_start: Option<usize> = None;
    let mut num_end = 0usize;
    let mut num_val: i64 = 0;
    let mut idx = 0usize;
    while idx < chars.len() {
        if chars[idx].is_ascii_digit() || "一二三四五六七八九十两".contains(chars[idx]) {
            let start = idx;
            while idx < chars.len() && (chars[idx].is_ascii_digit() || "一二三四五六七八九十两".contains(chars[idx])) {
                idx += 1;
            }
            let s: String = chars[start..idx].iter().collect();
            if let Some(v) = chinese_number(&s) {
                num_start = Some(start);
                num_end = idx;
                num_val = v;
                break;
            }
        } else {
            idx += 1;
        }
    }
    let (hour, minute, mut start_char, mut end_char) = match num_start {
        Some(start) if idx < chars.len() => {
            let mut hour = num_val;
            let mut minute = 0;
            let mut end = num_end;
            // 点/时
            let mut has_point = false;
            let mut scan = num_end;
            while scan < chars.len() && scan <= num_end + 2 {
                match chars[scan] {
                    '点' | '时' => { has_point = true; scan += 1; break; }
                    _ => scan += 1,
                }
            }
            if !has_point {
                return None;
            }
            end = scan;
            // 半 / N分
            if end < chars.len() && chars[end] == '半' {
                minute = 30;
                end += 1;
            } else {
                let mut mstart = end;
                let mut mval = 0;
                let mut mfound = false;
                while mstart < chars.len() && (chars[mstart].is_ascii_digit() || "一二三四五六七八九十".contains(chars[mstart])) {
                    mstart += 1;
                }
                if mstart > end && mstart < chars.len() && chars[mstart] == '分' {
                    let s: String = chars[end..mstart].iter().collect();
                    mval = chinese_number(&s).unwrap_or(0);
                    mfound = true;
                    end = mstart + 1;
                }
                if mfound {
                    minute = mval;
                }
            }
            if period_hour.is_some() && hour < 12 && (seg.contains("下午") || seg.contains("晚上") || seg.contains("傍晚")) {
                hour += 12;
            }
            if hour == 12 && (seg.contains("上午") || seg.contains("早上")) {
                hour = 0;
            }
            (hour, minute, start, end)
        }
        _ => {
            // 只有“上午/下午”等模糊时间：按“不猜”原则，不生成时刻
            return None;
        }
    };
    let _ = &mut start_char;
    let _ = &mut end_char;
    if !(0..24).contains(&hour) || !(0..60).contains(&minute) {
        return None;
    }
    Some((hour, minute, start_char, end_char))
}

fn strip_time_words(s: &str) -> String {
    let mut out = s.to_string();
    for w in ["今天", "明天", "后天", "大后天", "下周", "本周", "每天", "每周", "每月", "提醒我", "记得", "帮我", "我要"] {
        out = out.replace(w, "");
    }
    // 去掉单独的周几
    for c in ["一", "二", "三", "四", "五", "六", "日"] {
        out = out.replace(&format!("周{c}"), "");
        out = out.replace(&format!("星期{c}"), "");
    }
    for w in ["上午", "早上", "中午", "下午", "晚上", "傍晚"] {
        out = out.replace(w, "");
    }
    // 去掉时间数字+点/分/半
    let chars: Vec<char> = out.chars().collect();
    let mut cleaned = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() || "一二三四五六七八九十两".contains(chars[i]) {
            let start = i;
            while i < chars.len() && (chars[i].is_ascii_digit() || "一二三四五六七八九十两".contains(chars[i])) {
                i += 1;
            }
            let mut j = i;
            let mut dropped = false;
            while j < chars.len() && j <= i + 1 {
                match chars[j] {
                    '点' | '时' | '分' | '杯' | '次' | '个' | '遍' => {
                        j += 1;
                        dropped = true;
                    }
                    '半' => { j += 1; dropped = true; }
                    _ => break,
                }
            }
            if dropped {
                i = j;
                continue;
            }
            cleaned.extend(&chars[start..i]);
        } else {
            cleaned.push(chars[i]);
            i += 1;
        }
    }
    cleaned.trim_matches(|c: char| c.is_whitespace() || c == '，' || c == ',').to_string()
}

/// 规则解析一句话（保守：只拆逗号/分号；只取明确时间）。
pub fn parse(text: &str, now_utc: DateTime<Utc>, local_date: NaiveDate, offset_minutes: i32) -> Vec<ParsedItem> {
    let now_local = now_utc + Duration::minutes(offset_minutes as i64);
    let _ = now_local;
    let mut out = Vec::new();
    let segments: Vec<&str> = text
        .split(|c| c == '，' || c == ',' || c == '；' || c == ';' || c == '\n')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    for seg in segments {
        let mut new = NewEvent::default();
        let mut date: Option<NaiveDate> = None;
        let mut rule = String::from("none");

        // 日期：今天/明天/后天/大后天
        for (w, off) in [("今天", 0i64), ("明天", 1), ("后天", 2), ("大后天", 3)] {
            if seg.contains(w) {
                date = Some(local_date + Duration::days(off));
                rule = format!("date:{w}");
                break;
            }
        }
        // 下周X / 周X
        if date.is_none() {
            for prefix in ["下周", "本周", "周", "星期"] {
                if let Some(pos) = seg.find(prefix) {
                    let rest: Vec<char> = seg[pos + prefix.len()..].chars().take(1).collect();
                    if let Some(c) = rest.first() {
                        if let Some(target) = weekday_index(*c) {
                            let base = if prefix == "下周" { local_date + Duration::days(7) } else { local_date };
                            let d = next_weekday(base, target);
                            date = Some(d);
                            new.repeat_freq = None;
                            rule = format!("date:{prefix}{c}");
                            break;
                        }
                    }
                }
            }
        }
        // 周期：每天/每周X/每月N号（简化为 day / week 周几）
        if seg.contains("每天") {
            new.repeat_freq = Some("day".into());
            new.repeat_interval = Some(1);
            if date.is_none() {
                date = Some(local_date);
            }
            rule = "repeat:day".into();
        } else if seg.contains("每周") {
            new.repeat_freq = Some("week".into());
            new.repeat_interval = Some(1);
            for c in ["一", "二", "三", "四", "五", "六", "日"] {
                if seg.contains(&format!("每周{c}")) {
                    if let Some(t) = weekday_index(c.chars().next().unwrap()) {
                        new.repeat_weekdays = Some(vec![t]);
                        if date.is_none() {
                            date = Some(next_weekday(local_date, t));
                        }
                    }
                    break;
                }
            }
            rule = "repeat:week".into();
        }

        // 计数：N杯/次/个/遍（每天 N 次）
        if new.repeat_freq.as_deref() == Some("day") {
            let chars: Vec<char> = seg.chars().collect();
            let mut i = 0;
            while i < chars.len() {
                if chars[i].is_ascii_digit() || "一二三四五六七八九十两".contains(chars[i]) {
                    let start = i;
                    while i < chars.len() && (chars[i].is_ascii_digit() || "一二三四五六七八九十两".contains(chars[i])) {
                        i += 1;
                    }
                    let num_str: String = chars[start..i].iter().collect();
                    if i < chars.len() && "杯次个遍".contains(chars[i]) {
                        if let Some(n) = chinese_number(&num_str) {
                            new.count_target = Some(n);
                            new.count_period = Some("day".into());
                            new.repeat_freq = None; // 计数与重复互斥
                            new.repeat_interval = None;
                            rule = format!("count:day:{n}");
                            break;
                        }
                    }
                } else {
                    i += 1;
                }
            }
        }

        // 时刻
        if new.count_target.is_none() {
            if let Some((h, m, _, _)) = find_time_of_day(seg) {
                let d = date.unwrap_or(local_date);
                let local_dt = d.and_time(NaiveTime::from_hms_opt(h as u32, m as u32, 0).unwrap());
                let utc = Utc.from_utc_datetime(&(local_dt - Duration::minutes(offset_minutes as i64)));
                new.due_start_at = Some(utc.format("%Y-%m-%dT%H:%M:%SZ").to_string());
                rule = format!("{rule}+time");
            } else if let Some(d) = date {
                new.due_date = Some(d.format("%Y-%m-%d").to_string());
            }
        }
        if new.count_target.is_some() {
            new.due_date = None;
            new.due_start_at = None;
        }

        let title = strip_time_words(seg);
        new.title = if title.is_empty() { seg.to_string() } else { title };
        if new.title.chars().count() > 120 {
            new.title = new.title.chars().take(120).collect();
        }
        out.push(ParsedItem {
            event: new,
            confidence: if rule == "none" { 0.5 } else { 0.85 },
            rule,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn ctx() -> (DateTime<Utc>, NaiveDate, i32) {
        let now = Utc.with_ymd_and_hms(2026, 11, 1, 4, 0, 0).unwrap();
        (now, NaiveDate::from_ymd_opt(2026, 11, 1).unwrap(), 480)
    }

    #[test]
    fn parses_tomorrow_afternoon() {
        let (now, date, off) = ctx();
        let items = parse("明天下午三点跟张总开会", now, date, off);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].event.title, "跟张总开会");
        assert_eq!(items[0].event.due_start_at.as_deref(), Some("2026-11-02T07:00:00Z"));
    }

    #[test]
    fn parses_weekly() {
        let (now, date, off) = ctx();
        let items = parse("每周一10:00组会", now, date, off);
        assert_eq!(items[0].event.repeat_freq.as_deref(), Some("week"));
        assert_eq!(items[0].event.repeat_weekdays, Some(vec![1]));
        assert!(items[0].event.due_start_at.is_some());
    }

    #[test]
    fn parses_daily_count() {
        let (now, date, off) = ctx();
        let items = parse("每天喝三杯水", now, date, off);
        assert_eq!(items[0].event.count_target, Some(3));
        assert_eq!(items[0].event.count_period.as_deref(), Some("day"));
        assert!(items[0].event.title.contains("喝"));
    }

    #[test]
    fn splits_by_comma() {
        let (now, date, off) = ctx();
        let items = parse("明天下午三点开会，买牛奶", now, date, off);
        assert_eq!(items.len(), 2);
        assert_eq!(items[1].event.title, "买牛奶");
        assert!(items[1].event.due_date.is_none() && items[1].event.due_start_at.is_none());
    }
}
