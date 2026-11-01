//! 官方网关客户端 + 本地额度/激活码。
//! 客户端不含任何 AI Key；语音/解析都经官方网关。

use std::path::PathBuf;

use base64::Engine as _;
use chrono::{Local, NaiveDate, NaiveTime, TimeZone, Utc};
use clarify_core::NewEvent;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const DEFAULT_GATEWAY: &str = "https://clarify-gateway-dsidnsbafc.cn-hangzhou.fcapp.run";
const FREE_PARSE_PER_DAY: i64 = 5;
const FREE_VOICE_SECONDS_PER_DAY: i64 = 30;

fn gateway_url() -> String {
    option_env!("CLARIFY_GATEWAY_URL")
        .unwrap_or(DEFAULT_GATEWAY)
        .trim_end_matches('/')
        .to_string()
}

fn app_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn device_id(app: &AppHandle) -> String {
    let path = app_dir(app).join("device-id.txt");
    if let Ok(s) = std::fs::read_to_string(&path) {
        let s = s.trim().to_string();
        if !s.is_empty() {
            return s;
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::write(&path, &id);
    id
}

fn quota_path(app: &AppHandle) -> PathBuf {
    app_dir(app).join("quota.json")
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct LocalQuota {
    date: String,
    free_parse_used: i64,
    free_voice_sec: i64,
    activation_code: Option<String>,
    code_plan: Option<String>,
    code_expires_at: i64,
    code_parse_limit: i64,
    code_parse_used: i64,
    code_voice_limit: i64,
    code_voice_used: i64,
}

fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn load_quota(app: &AppHandle) -> LocalQuota {
    let mut q: LocalQuota = std::fs::read_to_string(quota_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_default();
    let d = today();
    if q.date != d {
        q.date = d;
        q.free_parse_used = 0;
        q.free_voice_sec = 0;
    }
    if q.activation_code.is_some() && q.code_expires_at > 0 && q.code_expires_at < now_ms() {
        q.activation_code = None;
        q.code_plan = None;
        q.code_expires_at = 0;
        q.code_parse_limit = 0;
        q.code_parse_used = 0;
        q.code_voice_limit = 0;
        q.code_voice_used = 0;
    }
    q
}

fn save_quota(app: &AppHandle, q: &LocalQuota) -> Result<(), String> {
    let s = serde_json::to_string_pretty(q).map_err(|e| e.to_string())?;
    std::fs::write(quota_path(app), s).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeStatus {
    pub plan: String,
    pub expires_at: i64,
    pub parse_limit: i64,
    pub parse_used: i64,
    pub parse_left: i64,
    pub voice_limit: i64,
    pub voice_used: i64,
    pub voice_left: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaStatus {
    pub date: String,
    pub free_parse_limit: i64,
    pub free_parse_used: i64,
    pub free_parse_left: i64,
    pub free_voice_limit: i64,
    pub free_voice_used: i64,
    pub free_voice_left: i64,
    pub code: Option<CodeStatus>,
}

fn status_from(q: &LocalQuota) -> QuotaStatus {
    let code = q.activation_code.as_ref().map(|_| CodeStatus {
        plan: q.code_plan.clone().unwrap_or_default(),
        expires_at: q.code_expires_at,
        parse_limit: q.code_parse_limit,
        parse_used: q.code_parse_used,
        parse_left: (q.code_parse_limit - q.code_parse_used).max(0),
        voice_limit: q.code_voice_limit,
        voice_used: q.code_voice_used,
        voice_left: (q.code_voice_limit - q.code_voice_used).max(0),
    });
    QuotaStatus {
        date: q.date.clone(),
        free_parse_limit: FREE_PARSE_PER_DAY,
        free_parse_used: q.free_parse_used,
        free_parse_left: (FREE_PARSE_PER_DAY - q.free_parse_used).max(0),
        free_voice_limit: FREE_VOICE_SECONDS_PER_DAY,
        free_voice_used: q.free_voice_sec,
        free_voice_left: (FREE_VOICE_SECONDS_PER_DAY - q.free_voice_sec).max(0),
        code,
    }
}

pub fn quota_status(app: &AppHandle) -> QuotaStatus {
    status_from(&load_quota(app))
}

fn has_code_parse_quota(q: &LocalQuota) -> bool {
    q.activation_code.is_some()
        && q.code_parse_limit > 0
        && q.code_parse_used < q.code_parse_limit
        && q.code_expires_at > now_ms()
}

fn has_code_voice_quota(q: &LocalQuota, seconds: i64) -> bool {
    q.activation_code.is_some()
        && q.code_voice_limit > 0
        && q.code_voice_used + seconds <= q.code_voice_limit
        && q.code_expires_at > now_ms()
}

fn check_parse(q: &LocalQuota) -> Result<(), String> {
    if has_code_parse_quota(q) || q.free_parse_used < FREE_PARSE_PER_DAY {
        Ok(())
    } else {
        Err(format!(
            "今日免费解析额度已用完（{} 次），可以明天再来或使用激活码",
            FREE_PARSE_PER_DAY
        ))
    }
}

fn check_voice(q: &LocalQuota, seconds: i64) -> Result<(), String> {
    if has_code_voice_quota(q, seconds) || q.free_voice_sec + seconds <= FREE_VOICE_SECONDS_PER_DAY {
        Ok(())
    } else {
        Err(format!(
            "今日免费语音额度已用完（{} 秒），可以明天再来或使用激活码",
            FREE_VOICE_SECONDS_PER_DAY
        ))
    }
}

fn consume_parse(q: &mut LocalQuota) {
    if has_code_parse_quota(q) {
        q.code_parse_used += 1;
    } else {
        q.free_parse_used += 1;
    }
}

fn consume_voice(q: &mut LocalQuota, seconds: i64) {
    if has_code_voice_quota(q, seconds) {
        q.code_voice_used += seconds;
    } else {
        q.free_voice_sec += seconds;
    }
}

#[derive(Debug, Deserialize)]
struct GatewayError {
    message: Option<String>,
    error: Option<String>,
}

async fn post_json(url: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网关请求失败: {e}"))?;
    if !resp.status().is_success() {
        let err: GatewayError = resp.json().await.unwrap_or(GatewayError { message: None, error: None });
        return Err(err.message.or(err.error).unwrap_or_else(|| "网关返回错误".into()));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("网关响应解析失败: {e}"))
}

fn local_to_utc(date: &str, time: &str, offset_minutes: i32) -> Option<String> {
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let t = NaiveTime::parse_from_str(time, "%H:%M").ok()?;
    let local = d.and_time(t);
    let utc = local - chrono::Duration::minutes(offset_minutes as i64);
    Some(Utc.from_utc_datetime(&utc).format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

#[derive(Debug, Deserialize)]
struct TaskJson {
    title: String,
    #[serde(default)]
    time_type: Option<String>,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    start: Option<String>,
    #[serde(default)]
    end: Option<String>,
    #[serde(default)]
    repeat: Option<String>,
    #[serde(default)]
    repeat_weekdays: Option<Vec<i64>>,
    #[serde(default)]
    count_target: Option<i64>,
    #[serde(default)]
    count_period: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ParseResponse {
    tasks: Vec<TaskJson>,
}

fn task_to_event(t: TaskJson, offset_minutes: i32) -> Option<NewEvent> {
    let title = t.title.trim().to_string();
    if title.is_empty() {
        return None;
    }
    let repeat = t.repeat.as_deref().filter(|s| !s.is_empty()).map(str::to_string);
    let mut ev = NewEvent { title, ..Default::default() };
    if let Some(r) = repeat {
        ev.repeat_freq = Some(r.clone());
        ev.repeat_interval = Some(1);
        if r == "week" {
            ev.repeat_weekdays = t.repeat_weekdays.filter(|v| !v.is_empty());
        }
    }
    if let Some(target) = t.count_target {
        ev.repeat_freq = None;
        ev.repeat_interval = None;
        ev.repeat_weekdays = None;
        ev.due_date = None;
        ev.due_start_at = None;
        ev.due_end_at = None;
        ev.count_target = Some(target);
        ev.count_period = t.count_period.or(Some("day".into()));
    } else {
        match t.time_type.as_deref() {
            Some("datetime") => {
                if let (Some(d), Some(s)) = (t.date.as_deref(), t.start.as_deref()) {
                    ev.due_start_at = local_to_utc(d, s, offset_minutes);
                }
            }
            Some("range") => {
                if let (Some(d), Some(s), Some(e)) = (t.date.as_deref(), t.start.as_deref(), t.end.as_deref()) {
                    ev.due_start_at = local_to_utc(d, s, offset_minutes);
                    ev.due_end_at = local_to_utc(d, e, offset_minutes);
                }
            }
            _ => {
                if let Some(d) = t.date.as_deref() {
                    if NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok() {
                        ev.due_date = Some(d.to_string());
                    }
                }
            }
        }
        if ev.repeat_freq.is_some() && ev.due_date.is_none() && ev.due_start_at.is_none() {
            ev.repeat_freq = None;
            ev.repeat_interval = None;
            ev.repeat_weekdays = None;
        }
    }
    Some(ev)
}

pub fn now_local_strings() -> (String, i32) {
    let now = Local::now();
    let offset = now.offset().local_minus_utc() / 60;
    (now.format("%Y-%m-%dT%H:%M:%S%:z").to_string(), offset)
}

pub async fn gateway_parse(app: &AppHandle, text: &str) -> Result<Vec<NewEvent>, String> {
    let q = load_quota(app);
    check_parse(&q)?;
    let (now_local, offset) = now_local_strings();
    let body = serde_json::json!({
        "text": text,
        "nowLocal": now_local,
        "deviceId": device_id(app),
        "activationCode": q.activation_code.clone(),
    });
    let url = format!("{}/v1/parse", gateway_url());
    let resp = post_json(&url, body).await?;
    let parsed: ParseResponse = serde_json::from_value(resp)
        .map_err(|e| format!("网关解析结果不合法: {e}"))?;
    let events: Vec<NewEvent> = parsed
        .tasks
        .into_iter()
        .filter_map(|t| task_to_event(t, offset))
        .collect();
    if !events.is_empty() {
        let mut q = load_quota(app);
        consume_parse(&mut q);
        save_quota(app, &q)?;
    }
    Ok(events)
}

pub async fn gateway_transcribe(app: &AppHandle, pcm: &[u8]) -> Result<String, String> {
    let seconds = ((pcm.len() as f64) / 32000.0).ceil() as i64;
    if seconds <= 0 {
        return Err("没有录到声音".into());
    }
    if seconds > 60 {
        return Err("单次语音不能超过 60 秒".into());
    }
    let q = load_quota(app);
    check_voice(&q, seconds)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(pcm);
    let body = serde_json::json!({
        "pcmBase64": b64,
        "deviceId": device_id(app),
        "activationCode": q.activation_code.clone(),
    });
    let url = format!("{}/v1/transcribe", gateway_url());
    let resp = post_json(&url, body).await?;
    let text = resp.get("text").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let mut q = load_quota(app);
    consume_voice(&mut q, seconds);
    save_quota(app, &q)?;
    Ok(text)
}

pub async fn set_activation_code(app: &AppHandle, code: &str) -> Result<QuotaStatus, String> {
    let code = code.trim();
    if code.is_empty() {
        let mut q = load_quota(app);
        q.activation_code = None;
        q.code_plan = None;
        q.code_expires_at = 0;
        q.code_parse_limit = 0;
        q.code_parse_used = 0;
        q.code_voice_limit = 0;
        q.code_voice_used = 0;
        save_quota(app, &q)?;
        return Ok(status_from(&q));
    }
    let mut url = reqwest::Url::parse(&format!("{}/v1/quota", gateway_url()))
        .map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("deviceId", &device_id(app))
        .append_pair("code", code);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| format!("网关请求失败: {e}"))?;
    let status = resp.status();
    let value: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(value
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("激活码验证失败")
            .to_string());
    }
    let code_info = value
        .get("quota")
        .and_then(|v| v.get("code"))
        .filter(|v| !v.is_null())
        .ok_or_else(|| "激活码无效或已过期".to_string())?;
    let plan = code_info.get("plan").and_then(|v| v.as_str()).unwrap_or("plus").to_string();
    let expires_at = code_info.get("expiresAt").and_then(|v| v.as_i64()).unwrap_or(0);
    let parse_limit = code_info.get("parseQuota").and_then(|v| v.as_i64()).unwrap_or(0);
    let voice_limit = code_info.get("voiceSeconds").and_then(|v| v.as_i64()).unwrap_or(0);
    let mut q = load_quota(app);
    let same = q.activation_code.as_deref() == Some(code);
    q.activation_code = Some(code.to_string());
    q.code_plan = Some(plan);
    q.code_expires_at = expires_at;
    q.code_parse_limit = parse_limit;
    q.code_voice_limit = voice_limit;
    if !same {
        q.code_parse_used = 0;
        q.code_voice_used = 0;
    }
    save_quota(app, &q)?;
    Ok(status_from(&q))
}
