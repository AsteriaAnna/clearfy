use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use base64::Engine;
use chrono::Local;
use clarify_core::{Clock, Event, NewEvent, Store, SystemClock};
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

pub mod ai;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct WindowRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct WindowStateFile {
    main: Option<WindowRect>,
    overlay: Option<WindowRect>,
}

struct AppState {
    store: Mutex<Store>,
    clock: SystemClock,
    window_state: Mutex<WindowStateFile>,
    last_state_save: Mutex<Instant>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
fn list_open(state: State<'_, AppState>) -> Result<Vec<Event>, String> {
    let store = state.store.lock().map_err(err)?;
    store.list_open().map_err(err)
}

#[tauri::command]
fn list_completed(state: State<'_, AppState>) -> Result<Vec<Event>, String> {
    let store = state.store.lock().map_err(err)?;
    store.list_completed(&state.clock).map_err(err)
}

#[tauri::command]
fn create_event(app: AppHandle, state: State<'_, AppState>, new: NewEvent) -> Result<Event, String> {
    let store = state.store.lock().map_err(err)?;
    let ev = store.create(&new, &state.clock).map_err(err)?;
    let _ = app.emit("clarify://changed", ());
    Ok(ev)
}

#[tauri::command]
fn complete_event(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Event, String> {
    let store = state.store.lock().map_err(err)?;
    let ev = store.complete(&id, &state.clock).map_err(err)?;
    let _ = app.emit("clarify://changed", ());
    Ok(ev)
}

#[tauri::command]
fn restore_event(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Event, String> {
    let store = state.store.lock().map_err(err)?;
    let ev = store.restore(&id).map_err(err)?;
    let _ = app.emit("clarify://changed", ());
    Ok(ev)
}

#[tauri::command]
fn increment_count(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Event, String> {
    let store = state.store.lock().map_err(err)?;
    let ev = store.increment_count(&id, &state.clock).map_err(err)?;
    let _ = app.emit("clarify://changed", ());
    Ok(ev)
}

#[tauri::command]
fn update_event(app: AppHandle, state: State<'_, AppState>, id: String, new: NewEvent) -> Result<Event, String> {
    let store = state.store.lock().map_err(err)?;
    let ev = store.update(&id, &new, &state.clock).map_err(err)?;
    let _ = app.emit("clarify://changed", ());
    Ok(ev)
}

#[tauri::command]
fn delete_event(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let store = state.store.lock().map_err(err)?;
    store.delete(&id).map_err(err)?;
    let _ = app.emit("clarify://changed", ());
    Ok(())
}

#[tauri::command]
fn purge_expired(state: State<'_, AppState>) -> Result<clarify_core::PurgeResult, String> {
    let store = state.store.lock().map_err(err)?;
    store.purge(&state.clock).map_err(err)
}

#[derive(serde::Serialize)]
struct AiParseOutcome {
    created: Vec<Event>,
    fallback: bool,
    warning: Option<String>,
}

fn rules_events(app: &AppHandle, text: &str) -> Result<Vec<NewEvent>, String> {
    let state = app.state::<AppState>();
    let offset = Local::now().offset().local_minus_utc() / 60;
    Ok(clarify_core::rules::parse(text, state.clock.now_utc(), state.clock.local_date(), offset)
        .into_iter()
        .map(|item| item.event)
        .collect())
}

#[tauri::command]
async fn ai_parse(app: AppHandle, text: String) -> Result<AiParseOutcome, String> {
    let (items, fallback, warning) = match ai::gateway_parse(&app, &text).await {
        Ok(v) if !v.is_empty() => (v, false, None),
        Ok(_) => (
            rules_events(&app, &text)?,
            true,
            Some("AI 未解析出任务，已用规则模式".to_string()),
        ),
        Err(e) => (
            rules_events(&app, &text)?,
            true,
            Some(format!("AI 解析失败，已用规则模式：{e}")),
        ),
    };
    let state = app.state::<AppState>();
    let store = state.store.lock().map_err(err)?;
    let mut created = Vec::new();
    let mut skipped = Vec::new();
    for item in items {
        match store.create(&item, &state.clock) {
            Ok(ev) => created.push(ev),
            Err(e) => skipped.push(e.to_string()),
        }
    }
    if created.is_empty() {
        return Err(format!("没有创建成功：{}", skipped.join("；")));
    }
    let warning = warning.or_else(|| {
        if skipped.is_empty() {
            None
        } else {
            Some(format!("部分未创建：{}", skipped.join("；")))
        }
    });
    let _ = app.emit("clarify://changed", ());
    Ok(AiParseOutcome { created, fallback, warning })
}

#[tauri::command]
async fn transcribe_stream(app: AppHandle, pcm_base64: String) -> Result<String, String> {
    let pcm = base64::engine::general_purpose::STANDARD
        .decode(pcm_base64.as_bytes())
        .map_err(|e| e.to_string())?;
    ai::gateway_transcribe(&app, &pcm).await
}

#[tauri::command]
fn quota_status(app: AppHandle) -> ai::QuotaStatus {
    ai::quota_status(&app)
}

#[tauri::command]
async fn save_activation_code(app: AppHandle, code: String) -> Result<ai::QuotaStatus, String> {
    ai::set_activation_code(&app, &code).await
}

#[tauri::command]
fn create_from_capture(app: AppHandle, state: State<'_, AppState>, text: String) -> Result<Vec<Event>, String> {
    let offset = Local::now().offset().local_minus_utc() / 60;
    let items = clarify_core::rules::parse(&text, state.clock.now_utc(), state.clock.local_date(), offset);
    if items.is_empty() {
        return Err("没有识别出可创建的内容".into());
    }
    let store = state.store.lock().map_err(err)?;
    let mut created = Vec::new();
    for item in items {
        match store.create(&item.event, &state.clock) {
            Ok(ev) => created.push(ev),
            Err(e) => return Err(e.to_string()),
        }
    }
    let _ = app.emit("clarify://changed", ());
    Ok(created)
}

#[tauri::command]
fn open_main_today(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    let _ = app.emit("clarify://open-today", ());
    Ok(())
}

fn db_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    dir.join("clarify.db")
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn window_state_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    dir.join("window-state.json")
}

fn load_window_state(app: &AppHandle) -> WindowStateFile {
    std::fs::read_to_string(window_state_path(app))
        .ok()
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_default()
}

fn persist_window_state(app: &AppHandle, state: &WindowStateFile) {
    if let Ok(s) = serde_json::to_string_pretty(state) {
        let _ = std::fs::write(window_state_path(app), s);
    }
}

fn rect_on_screen(app: &AppHandle, rect: &WindowRect) -> bool {
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let size = monitor.size();
        let w = size.width as f64;
        let h = size.height as f64;
        rect.x > -rect.width + 80.0
            && rect.y > -rect.height + 80.0
            && rect.x < w - 80.0
            && rect.y < h - 80.0
    } else {
        true
    }
}

fn apply_window_rect(window: &WebviewWindow, rect: &WindowRect) {
    let _ = window.set_size(PhysicalSize::new(
        rect.width.max(240.0) as u32,
        rect.height.max(160.0) as u32,
    ));
    let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
}

fn save_window_rect(window: &tauri::Window, force: bool) {
    let app = window.app_handle();
    let Some(state) = app.try_state::<AppState>() else { return };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let rect = WindowRect {
        x: pos.x as f64,
        y: pos.y as f64,
        width: size.width as f64,
        height: size.height as f64,
    };
    let now = Instant::now();
    let should = force || {
        let last = state.last_state_save.lock().unwrap();
        now.duration_since(*last).as_millis() >= 300
    };
    if !should {
        return;
    }
    let snapshot = {
        let mut ws = state.window_state.lock().unwrap();
        match window.label() {
            "main" => ws.main = Some(rect),
            "overlay" => ws.overlay = Some(rect),
            _ => return,
        }
        ws.clone()
    };
    *state.last_state_save.lock().unwrap() = now;
    persist_window_state(app, &snapshot);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let capture_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
    let voice_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyV);
    let handler_capture = capture_shortcut.clone();
    let handler_voice = voice_shortcut.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &handler_capture {
                        if let Some(main) = app.get_webview_window("main") {
                            let _ = main.show();
                            let _ = main.set_focus();
                        }
                        let _ = app.emit("clarify://capture", ());
                    } else if shortcut == &handler_voice {
                        if let Some(main) = app.get_webview_window("main") {
                            let _ = main.show();
                            let _ = main.set_focus();
                        }
                        let _ = app.emit("clarify://voice", ());
                    }
                })
                .build(),
        )
        .setup(move |app| {
            let path = db_path(app.handle());
            let store = Store::open(path.to_string_lossy().as_ref())
                .expect("failed to open clarify.db");
            // 启动时做一次 24h 物理清理 + 计数周期复位
            let clock = SystemClock::default();
            let _ = store.purge(&clock);
            let wstate = load_window_state(app.handle());
            app.manage(AppState {
                store: Mutex::new(store),
                clock,
                window_state: Mutex::new(wstate.clone()),
                last_state_save: Mutex::new(Instant::now()),
            });
            app.global_shortcut()
                .register(capture_shortcut)
                .map_err(|e| e.to_string())?;
            app.global_shortcut()
                .register(voice_shortcut)
                .map_err(|e| e.to_string())?;

            // 恢复主窗位置/尺寸
            if let Some(rect) = &wstate.main {
                if rect_on_screen(app.handle(), rect) {
                    if let Some(main) = app.get_webview_window("main") {
                        apply_window_rect(&main, rect);
                    }
                }
            }

            // 浮窗：独立透明窗口，支持折叠为 64×64 符号
            let builder = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
                .title("Clarify")
                .inner_size(300.0, 260.0)
                .min_inner_size(64.0, 64.0)
                .max_inner_size(300.0, 420.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false)
                .resizable(true);
            let overlay = builder.build()?;
            let mut overlay_restored = false;
            if let Some(rect) = &wstate.overlay {
                if rect_on_screen(app.handle(), rect) {
                    let scale = overlay.scale_factor().unwrap_or(1.0);
                    let width = rect.width.clamp(64.0 * scale, 300.0 * scale) as u32;
                    let height = rect.height.clamp(64.0 * scale, 420.0 * scale) as u32;
                    let _ = overlay.set_size(PhysicalSize::new(width, height));
                    let _ = overlay.set_position(PhysicalPosition::new(rect.x, rect.y));
                    overlay_restored = true;
                }
            }
            if !overlay_restored {
                if let Ok(Some(monitor)) = app.primary_monitor() {
                    let scale = monitor.scale_factor();
                    let size = monitor.size();
                    let x = size.width as f64 - 300.0 * scale - 24.0 * scale;
                    let y = size.height as f64 - 220.0 * scale - 80.0 * scale;
                    let _ = overlay.set_position(PhysicalPosition::new(x, y));
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                save_window_rect(window, true);
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                save_window_rect(window, false);
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            list_open,
            list_completed,
            create_event,
            complete_event,
            restore_event,
            increment_count,
            update_event,
            delete_event,
            purge_expired,
            open_main_today,
            create_from_capture,
            ai_parse,
            transcribe_stream,
            quota_status,
            save_activation_code,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
