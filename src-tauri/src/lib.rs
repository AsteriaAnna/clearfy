use std::sync::Mutex;

use clarify_core::{Event, NewEvent, Store, SystemClock};
use tauri::{Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

struct AppState {
    store: Mutex<Store>,
    clock: SystemClock,
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
fn create_event(state: State<'_, AppState>, new: NewEvent) -> Result<Event, String> {
    let store = state.store.lock().map_err(err)?;
    store.create(&new, &state.clock).map_err(err)
}

#[tauri::command]
fn complete_event(state: State<'_, AppState>, id: String) -> Result<Event, String> {
    let store = state.store.lock().map_err(err)?;
    store.complete(&id, &state.clock).map_err(err)
}

#[tauri::command]
fn restore_event(state: State<'_, AppState>, id: String) -> Result<Event, String> {
    let store = state.store.lock().map_err(err)?;
    store.restore(&id).map_err(err)
}

#[tauri::command]
fn increment_count(state: State<'_, AppState>, id: String) -> Result<Event, String> {
    let store = state.store.lock().map_err(err)?;
    store.increment_count(&id, &state.clock).map_err(err)
}

#[tauri::command]
fn update_event(state: State<'_, AppState>, id: String, new: NewEvent) -> Result<Event, String> {
    let store = state.store.lock().map_err(err)?;
    store.update(&id, &new, &state.clock).map_err(err)
}

#[tauri::command]
fn delete_event(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let store = state.store.lock().map_err(err)?;
    store.delete(&id).map_err(err)
}

#[tauri::command]
fn purge_expired(state: State<'_, AppState>) -> Result<clarify_core::PurgeResult, String> {
    let store = state.store.lock().map_err(err)?;
    store.purge(&state.clock).map_err(err)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let path = db_path(app.handle());
            let store = Store::open(path.to_string_lossy().as_ref())
                .expect("failed to open clarify.db");
            // 启动时做一次 24h 物理清理 + 计数周期复位
            let clock = SystemClock::default();
            let _ = store.purge(&clock);
            app.manage(AppState {
                store: Mutex::new(store),
                clock,
            });

            // 浮窗：独立透明窗口，300×220 起，A 最高 396 / B 最高 420
            let builder = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
                .title("Clarify")
                .inner_size(300.0, 220.0)
                .min_inner_size(300.0, 180.0)
                .max_inner_size(300.0, 420.0)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false)
                .resizable(true);
            let overlay = builder.build()?;
            if let Ok(Some(monitor)) = app.primary_monitor() {
                let scale = monitor.scale_factor();
                let size = monitor.size();
                let x = size.width as f64 - 300.0 * scale - 24.0 * scale;
                let y = size.height as f64 - 220.0 * scale - 80.0 * scale;
                let _ = overlay.set_position(PhysicalPosition::new(x, y));
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
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
            open_main_today
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
