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
    let mut cfg: AiConfig = std::fs::read_to_string(config_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_default();
    // 内置 Key：编译期注入（option_env），用户在界面上不需要配置。
    if cfg.deepseek_key.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_none() {
        cfg.deepseek_key = option_env!("CLARIFY_DEEPSEEK_KEY")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
    }
    if cfg.doubao_key.as_deref().map(str::trim).filter(|s| !s.is_empty()).is_none() {
        cfg.doubao_key = option_env!("CLARIFY_DOUBAO_KEY")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
    }
    cfg
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

// ---------------- 豆包流式语音识别（SAUC bigmodel_async） ----------------

const SAUC_URL: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
const SAUC_RESOURCE_ID: &str = "volc.seedasr.sauc.duration";

fn build_client_frame(msg_type: u8, flags: u8, serialization: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(payload.len() + 8);
    v.push(0x11);
    v.push((msg_type << 4) | (flags & 0x0f));
    v.push((serialization << 4) & 0xf0);
    v.push(0x00);
    v.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    v.extend_from_slice(payload);
    v
}

struct ServerFrame {
    msg_type: u8,
    flags: u8,
    sequence: Option<i32>,
    payload: Vec<u8>,
    error_code: Option<u32>,
    error_message: String,
}

fn parse_server_frame(data: &[u8]) -> Result<ServerFrame, String> {
    if data.len() < 4 {
        return Err("服务端帧过短".into());
    }
    let msg_type = (data[1] >> 4) & 0x0f;
    let flags = data[1] & 0x0f;
    let compression = data[2] & 0x0f;
    let mut pos = 4usize;
    if msg_type == 0x0f {
        if pos + 4 > data.len() {
            return Err("错误帧缺少错误码".into());
        }
        let code = u32::from_be_bytes(data[pos..pos + 4].try_into().unwrap());
        pos += 4;
        let mut msg = String::new();
        if pos + 4 <= data.len() {
            let len = u32::from_be_bytes(data[pos..pos + 4].try_into().unwrap()) as usize;
            pos += 4;
            let end = (pos + len).min(data.len());
            msg = String::from_utf8_lossy(&data[pos..end]).to_string();
        }
        return Ok(ServerFrame { msg_type, flags, sequence: None, payload: vec![], error_code: Some(code), error_message: msg });
    }
    let mut sequence = None;
    if matches!(flags & 0b0011, 0b0001 | 0b0011) && pos + 4 <= data.len() {
        sequence = Some(i32::from_be_bytes(data[pos..pos + 4].try_into().unwrap()));
        pos += 4;
    }
    if pos + 4 > data.len() {
        return Err("服务端帧缺少 payload 长度".into());
    }
    let len = u32::from_be_bytes(data[pos..pos + 4].try_into().unwrap()) as usize;
    pos += 4;
    let end = (pos + len).min(data.len());
    let mut payload = data[pos..end].to_vec();
    if compression == 1 && !payload.is_empty() {
        use std::io::Read;
        let mut gz = flate2::read::GzDecoder::new(&payload[..]);
        let mut out = Vec::new();
        gz.read_to_end(&mut out).map_err(|e| format!("gzip 解压失败: {e}"))?;
        payload = out;
    }
    Ok(ServerFrame { msg_type, flags, sequence, payload, error_code: None, error_message: String::new() })
}

/// 用豆包流式识别（2.0 小时版）转写一段 16k/16bit/单声道 PCM。
pub async fn stream_transcribe(pcm: &[u8], key: &str) -> Result<String, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;

    if pcm.is_empty() {
        return Err("没有录到声音".into());
    }
    let mut req = SAUC_URL.into_client_request().map_err(|e| e.to_string())?;
    {
        let headers = req.headers_mut();
        headers.insert("X-Api-Key", key.parse().map_err(|_| "Key 非法")?);
        headers.insert("X-Api-Resource-Id", SAUC_RESOURCE_ID.parse().map_err(|_| "resource 非法")?);
        headers.insert("X-Api-Connect-Id", uuid::Uuid::new_v4().to_string().parse().map_err(|_| "uuid 非法")?);
        headers.insert("X-Api-Request-Id", uuid::Uuid::new_v4().to_string().parse().map_err(|_| "uuid 非法")?);
        headers.insert("X-Api-Sequence", "-1".parse().map_err(|_| "seq 非法")?);
    }
    let (mut ws, _resp) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| format!("连接豆包流式服务失败: {e}"))?;

    let start = serde_json::json!({
        "user": {"uid": "clarify"},
        "audio": {"format": "pcm", "rate": 16000, "bits": 16, "channel": 1, "language": "zh-CN"},
        "request": {
            "model_name": "bigmodel",
            "enable_itn": true,
            "enable_punc": true,
            "show_utterances": true,
            "result_type": "full",
            "enable_nonstream": false
        }
    });
    ws.send(Message::Binary(
        build_client_frame(0b0001, 0b0000, 0b0001, start.to_string().as_bytes()).into(),
    ))
    .await
    .map_err(|e| e.to_string())?;

    let chunk = 6400usize;
    let mut sent_final = false;
    for piece in pcm.chunks(chunk) {
        let final_packet = piece.len() < chunk;
        let flags = if final_packet { 0b0010 } else { 0b0000 };
        ws.send(Message::Binary(
            build_client_frame(0b0010, flags, 0b0000, piece).into(),
        ))
        .await
        .map_err(|e| e.to_string())?;
        if final_packet {
            sent_final = true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    if !sent_final {
        ws.send(Message::Binary(
            build_client_frame(0b0010, 0b0010, 0b0000, &[]).into(),
        ))
        .await
        .map_err(|e| e.to_string())?;
    }

    let mut final_text = String::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let msg = tokio::time::timeout_at(deadline, ws.next())
            .await
            .map_err(|_| "等待识别结果超时".to_string())?;
        let Some(msg) = msg else { break };
        match msg.map_err(|e| e.to_string())? {
            Message::Binary(bytes) => {
                let frame = parse_server_frame(&bytes)?;
                if frame.msg_type == 0x0f {
                    return Err(format!(
                        "豆包识别错误 [{}] {}",
                        frame.error_code.unwrap_or(0),
                        frame.error_message
                    ));
                }
                if frame.msg_type == 0b1001 && !frame.payload.is_empty() {
                    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&frame.payload) {
                        if let Some(text) = v["result"]["text"].as_str() {
                            if !text.is_empty() {
                                final_text = text.to_string();
                            }
                        }
                    }
                    let is_final = frame.flags & 0b0010 != 0 || frame.sequence.unwrap_or(0) < 0;
                    if is_final {
                        break;
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
    let _ = ws.close(None).await;
    Ok(final_text)
}

#[allow(dead_code)]
fn _keep_imports_used(_: DateTime<Utc>) {}
