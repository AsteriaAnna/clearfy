use std::sync::Mutex;

use clarify_core::{Event, NewEvent, Store, SystemClock};
use tauri::{Manager, State};

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
fn delete_event(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let store = state.store.lock().map_err(err)?;
    store.delete(&id).map_err(err)
}

#[tauri::command]
fn purge_expired(state: State<'_, AppState>) -> Result<clarify_core::PurgeResult, String> {
    let store = state.store.lock().map_err(err)?;
    store.purge(&state.clock).map_err(err)
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_open,
            list_completed,
            create_event,
            complete_event,
            restore_event,
            increment_count,
            delete_event,
            purge_expired
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
