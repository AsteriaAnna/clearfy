//! 云端 AI 客户端：DeepSeek 文本解析 + 豆包(火山)语音识别。
//! Key 只存本机 AppData 配置文件，不写入仓库、不打印日志。

use std::path::PathBuf;
use std::time::Duration;

use base64::Engine;
use chrono::{DateTime, NaiveDate, NaiveTime, TimeZone, Utc};
use clarify_core::NewEvent;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const DEEPSEEK_URL: &str = "https://api.deepseek.com/chat/completions";
const DOUBAO_FLASH_URL: &str = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
const DOUBAO_RESOURCE_ID: &str = "volc.bigasr.auc_turbo";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AiConfig {
    pub deepseek_key: Option<String>,
    pub doubao_key: Option<String>,
}

pub fn config_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    dir.join("ai-config.json")
}

pub fn load_config(app: &AppHandle) -> AiConfig {
    std::fs::read_to_string(config_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_default()
}

pub fn save_config(app: &AppHandle, cfg: &AiConfig) -> Result<(), String> {
    let s = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(config_path(app), s).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AiStatus {
    pub deepseek_configured: bool,
    pub doubao_configured: bool,
}

pub fn status(app: &AppHandle) -> AiStatus {
    let cfg = load_config(app);
    AiStatus {
        deepseek_configured: cfg.deepseek_key.as_deref().map(str::trim).map(|s| !s.is_empty()).unwrap_or(false),
        doubao_configured: cfg.doubao_key.as_deref().map(str::trim).map(|s| !s.is_empty()).unwrap_or(false),
    }
}

#[derive(Debug, Deserialize)]
struct DsResp {
    choices: Vec<DsChoice>,
}
#[derive(Debug, Deserialize)]
struct DsChoice {
    message: DsMsg,
}
#[derive(Debug, Deserialize)]
struct DsMsg {
    content: String,
}
#[derive(Debug, Deserialize)]
struct DsTasks {
    tasks: Vec<DsTask>,
}
#[derive(Debug, Deserialize)]
struct DsTask {
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

fn prompt_system() -> &'static str {
    "你是 Clarify 待办解析器。只输出严格 JSON，不要解释。\
输出格式：{\"tasks\":[{\"title\":\"动作短语\",\"time_type\":\"date|datetime|range|none\",\
\"date\":\"YYYY-MM-DD 或 null\",\"start\":\"HH:MM 或 null\",\"end\":\"HH:MM 或 null\",\
\"repeat\":\"day|week|month 或 null\",\"repeat_weekdays\":[1-7] 或 null,\
\"count_target\":整数或null,\"count_period\":\"day|week 或 null\"}]}。\
规则：只提取用户明确说出的时间/重复/计数；没说就不填(null)，绝不猜测；\
按动作拆成多条；标题是动作不是原话。"
}

fn local_to_utc(date: &str, time: &str, offset_minutes: i32) -> Option<String> {
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let t = NaiveTime::parse_from_str(time, "%H:%M").ok()?;
    let local = d.and_time(t);
    let utc = local - chrono::Duration::minutes(offset_minutes as i64);
    Some(Utc.from_utc_datetime(&utc).format("%Y-%m-%dT%H:%M:%SZ").to_string())
}

/// 调用 DeepSeek，把一句话解析为待办输入（可能多条）。
pub async fn deepseek_parse(
    text: &str,
    now_local_iso: &str,
    offset_minutes: i32,
    key: &str,
) -> Result<Vec<NewEvent>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "model": "deepseek-flash",
        "messages": [
            {"role": "system", "content": prompt_system()},
            {"role": "user", "content": format!("输入：{text}\n当前时间：{now_local_iso}")}
        ],
        "response_format": {"type": "json_object"},
        "thinking": {"type": "disabled"},
        "max_tokens": 800
    });
    let resp = client
        .post(DEEPSEEK_URL)
        .header("Authorization", format!("Bearer {key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("DeepSeek 请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("DeepSeek HTTP {}", resp.status()));
    }
    let parsed: DsResp = resp.json().await.map_err(|e| format!("DeepSeek 响应解析失败: {e}"))?;
    let content = parsed
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_default();
    let tasks: DsTasks = serde_json::from_str(&content)
        .map_err(|e| format!("DeepSeek JSON 不合法: {e}; content={content}"))?;
    let mut out = Vec::new();
    for t in tasks.tasks {
        let title = t.title.trim().to_string();
        if title.is_empty() {
            continue;
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
                Some("date") | Some("none") | _ => {
                    if let Some(d) = t.date.as_deref() {
                        if NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok() {
                            ev.due_date = Some(d.to_string());
                        }
                    }
                }
            }
            // 重复事件需要时间锚点；没有就丢弃 repeat
            if ev.repeat_freq.is_some() && ev.due_date.is_none() && ev.due_start_at.is_none() {
                ev.repeat_freq = None;
                ev.repeat_interval = None;
                ev.repeat_weekdays = None;
            }
        }
        out.push(ev);
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
struct DoubaoResp {
    #[serde(default)]
    result: Option<DoubaoResult>,
}
#[derive(Debug, Deserialize)]
struct DoubaoResult {
    #[serde(default)]
    text: String,
    #[serde(default)]
    utterances: Vec<DoubaoUtterance>,
}
#[derive(Debug, Deserialize)]
struct DoubaoUtterance {
    #[serde(default)]
    text: String,
}

/// 豆包录音文件识别（极速版，同步返回）。需要控制台开通 `volc.bigasr.auc_turbo`。
pub async fn doubao_transcribe(audio: &[u8], format: &str, key: &str) -> Result<String, String> {
    let b64 = base64::engine::general_purpose::STANDARD.encode(audio);
    let body = serde_json::json!({
        "user": {"uid": "clarify"},
        "audio": {"format": format, "data": b64},
        "request": {"model_name": "bigmodel", "enable_itn": true, "show_utterances": true}
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(DOUBAO_FLASH_URL)
        .header("X-Api-Key", key)
        .header("X-Api-Resource-Id", DOUBAO_RESOURCE_ID)
        .header("X-Api-Request-Id", uuid::Uuid::new_v4().to_string())
        .header("X-Api-Sequence", "-1")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("豆包请求失败: {e}"))?;
    let status_code = resp
        .headers()
        .get("X-Api-Status-Code")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let status_msg = resp
        .headers()
        .get("X-Api-Message")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !resp.status().is_success() || (status_code != "20000000" && status_code != "20000003") {
        return Err(format!("豆包识别失败 [{status_code}] {status_msg}"));
    }
    if status_code == "20000003" {
        return Ok(String::new());
    }
    let data: DoubaoResp = resp.json().await.map_err(|e| e.to_string())?;
    let result = data.result.unwrap_or(DoubaoResult { text: String::new(), utterances: vec![] });
    let joined = result
        .utterances
        .iter()
        .map(|u| u.text.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("");
    if !joined.is_empty() {
        return Ok(joined);
    }
    Ok(result.text)
}

/// 当前本地时间（用于 prompt），以及 UTC offset 分钟。
pub fn now_local_strings() -> (String, i32) {
    let now = chrono::Local::now();
    let offset = now.offset().local_minus_utc() / 60;
    (now.format("%Y-%m-%dT%H:%M:%S%:z").to_string(), offset)
}

#[allow(dead_code)]
fn _keep_imports_used(_: DateTime<Utc>) {}
