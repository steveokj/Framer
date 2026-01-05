use anyhow::{Context, Result};
use chrono::{DateTime, Local};
use crossbeam_channel::{bounded, Receiver, Sender};
use once_cell::sync::OnceCell;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HMODULE, HWND, LPARAM, LRESULT, POINT, RECT, STILL_ACTIVE, WPARAM};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetCurrentThreadId, GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyboardLayout, GetKeyboardState, ToUnicodeEx, VK_BACK, VK_CONTROL, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN,
    VK_MENU, VK_RCONTROL, VK_RETURN, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT, VK_TAB,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK, UIA_CONTROLTYPE_ID,
    UIA_DocumentControlTypeId, UIA_EditControlTypeId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetClassNameW, GetForegroundWindow, GetMessageW, GetWindowRect, GetWindowTextW,
    GetWindowThreadProcessId, PostThreadMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx,
    EVENT_OBJECT_LOCATIONCHANGE, EVENT_SYSTEM_FOREGROUND, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, OBJID_WINDOW,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WINEVENT_OUTOFCONTEXT, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_QUIT,
    WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN,
    WM_SYSKEYUP,
};

const APP_DIR: &str = "data\\timestone";
const DB_NAME: &str = "timestone_events.sqlite3";
const LOCK_FILE: &str = "recorder.lock";
const STOP_FILE: &str = "stop.signal";
const CONFIG_FILE: &str = "config.json";

static STATE: OnceCell<Arc<RecorderState>> = OnceCell::new();
thread_local! {
    static UIA: RefCell<Option<IUIAutomation>> = RefCell::new(None);
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct RecorderConfig {
    mouse_hz: u64,
    snapshot_hz: u64,
    emit_snapshots: bool,
    emit_mouse_move: bool,
    emit_mouse_scroll: bool,
    window_poll_hz: u64,
    capture_raw_keys: bool,
    raw_keys_mode: String,
    suppress_raw_keys_on_shortcut: bool,
    obs_video_path: Option<String>,
    obs_video_dir: Option<String>,
    safe_text_only: bool,
    allowlist_processes: Vec<String>,
    blocklist_processes: Vec<String>,
    text_flush_ms: u64,
    max_text_len: usize,
}

impl Default for RecorderConfig {
    fn default() -> Self {
        Self {
            mouse_hz: 30,
            snapshot_hz: 1,
            emit_snapshots: false,
            emit_mouse_move: false,
            emit_mouse_scroll: false,
            window_poll_hz: 0,
            capture_raw_keys: true,
            raw_keys_mode: "down".to_string(),
            suppress_raw_keys_on_shortcut: true,
            obs_video_path: None,
            obs_video_dir: None,
            safe_text_only: true,
            allowlist_processes: Vec::new(),
            blocklist_processes: vec![
                "1password.exe".to_string(),
                "keepass.exe".to_string(),
                "bitwarden.exe".to_string(),
            ],
            text_flush_ms: 1500,
            max_text_len: 2000,
        }
    }
}

#[derive(Default)]
struct CliOverrides {
    config_path: Option<PathBuf>,
    mouse_hz: Option<u64>,
    snapshot_hz: Option<u64>,
    capture_raw_keys: Option<bool>,
    obs_video_path: Option<String>,
    obs_video_dir: Option<String>,
    safe_text_only: Option<bool>,
}

#[derive(Clone)]
struct SessionInfo {
    session_id: String,
    start_wall_ms: i64,
    start_wall_iso: String,
    obs_video_path: Option<String>,
}

struct TextBuffer {
    text: String,
    last_ts_ms: i64,
}

struct RecorderState {
    session_id: String,
    sender: Sender<EventRecord>,
    start_instant: Instant,
    mouse_move_interval_ms: i64,
    last_mouse_move_ms: AtomicI64,
    capture_raw_keys: bool,
    raw_keys_mode: RawKeysMode,
    suppress_raw_keys_on_shortcut: bool,
    emit_mouse_move: bool,
    emit_mouse_scroll: bool,
    pressed_keys: Mutex<HashSet<u32>>,
    safe_text_only: bool,
    allowlist_processes: Vec<String>,
    blocklist_processes: Vec<String>,
    text_flush_ms: i64,
    max_text_len: usize,
    text_buffer: Mutex<TextBuffer>,
    window_tracker: Mutex<WindowTracker>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RawKeysMode {
    Down,
    Up,
    Both,
}

#[derive(Serialize, Clone, PartialEq)]
struct RectInfo {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    width: i32,
    height: i32,
}

#[derive(Serialize, Clone)]
struct MouseInfo {
    x: i32,
    y: i32,
    button: Option<String>,
    delta: Option<i32>,
}

#[derive(Clone)]
struct EventRecord {
    session_id: String,
    ts_wall_ms: i64,
    ts_mono_ms: i64,
    event_type: String,
    process_name: Option<String>,
    window_title: Option<String>,
    window_class: Option<String>,
    window_rect: Option<RectInfo>,
    mouse: Option<MouseInfo>,
    payload: Value,
}

fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("start") => {
            let overrides = parse_start_args(args);
            run_recorder(overrides)?;
        }
        Some("stop") => {
            stop_recorder()?;
        }
        Some("status") => {
            print_status()?;
        }
        _ => {
            print_usage();
        }
    }
    Ok(())
}

fn print_usage() {
    println!("timestone_recorder");
    println!("Usage:");
    println!("  timestone_recorder start [--config PATH] [--safe-text|--no-safe-text] [--raw-keys]");
    println!("                           [--mouse-hz N] [--snapshot-hz N] [--obs-video PATH] [--obs-dir PATH]");
    println!("  timestone_recorder stop");
    println!("  timestone_recorder status");
}

fn parse_start_args(mut args: impl Iterator<Item = String>) -> CliOverrides {
    let mut overrides = CliOverrides::default();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" => {
                if let Some(value) = args.next() {
                    overrides.config_path = Some(PathBuf::from(value));
                }
            }
            "--safe-text" => {
                overrides.safe_text_only = Some(true);
            }
            "--no-safe-text" => {
                overrides.safe_text_only = Some(false);
            }
            "--raw-keys" => {
                overrides.capture_raw_keys = Some(true);
            }
            "--mouse-hz" => {
                if let Some(value) = args.next() {
                    if let Ok(parsed) = value.parse::<u64>() {
                        overrides.mouse_hz = Some(parsed.max(1));
                    }
                }
            }
            "--snapshot-hz" => {
                if let Some(value) = args.next() {
                    if let Ok(parsed) = value.parse::<u64>() {
                        overrides.snapshot_hz = Some(parsed.max(1));
                    }
                }
            }
            "--obs-video" => {
                if let Some(value) = args.next() {
                    overrides.obs_video_path = Some(value);
                }
            }
            "--obs-dir" => {
                if let Some(value) = args.next() {
                    overrides.obs_video_dir = Some(value);
                }
            }
            _ => {}
        }
    }
    overrides
}

fn run_recorder(overrides: CliOverrides) -> Result<()> {
    let base_dir = ensure_app_dir()?;
    let config = load_config(&base_dir, &overrides)?;
    let lock_path = base_dir.join(LOCK_FILE);
    if lock_path.exists() {
        println!("Recorder already running (lock file present).");
        return Ok(());
    }

    let _com_guard = ComGuard::new(config.safe_text_only);
    let main_thread_id = unsafe { GetCurrentThreadId() };

    let session_id = Uuid::new_v4().to_string();
    let start_wall_ms = now_wall_ms();
    let start_wall_iso = DateTime::<Local>::from(SystemTime::now()).to_rfc3339();
    let session = SessionInfo {
        session_id: session_id.clone(),
        start_wall_ms,
        start_wall_iso,
        obs_video_path: config.obs_video_path.clone(),
    };

    write_lock(&lock_path, &session)?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let (tx, rx) = bounded::<EventRecord>(20_000);
    let start_instant = Instant::now();

    let state = Arc::new(RecorderState {
        session_id: session_id.clone(),
        sender: tx.clone(),
        start_instant,
        mouse_move_interval_ms: (1000 / config.mouse_hz.max(1)) as i64,
        last_mouse_move_ms: AtomicI64::new(-1),
        capture_raw_keys: config.capture_raw_keys,
        raw_keys_mode: parse_raw_keys_mode(&config.raw_keys_mode),
        suppress_raw_keys_on_shortcut: config.suppress_raw_keys_on_shortcut,
        emit_mouse_move: config.emit_mouse_move,
        emit_mouse_scroll: config.emit_mouse_scroll,
        pressed_keys: Mutex::new(HashSet::new()),
        safe_text_only: config.safe_text_only,
        allowlist_processes: config.allowlist_processes.clone(),
        blocklist_processes: config.blocklist_processes.clone(),
        text_flush_ms: config.text_flush_ms as i64,
        max_text_len: config.max_text_len,
        text_buffer: Mutex::new(TextBuffer {
            text: String::new(),
            last_ts_ms: 0,
        }),
        window_tracker: Mutex::new(WindowTracker {
            last_hwnd: HWND(0),
            last_rect: None,
        }),
    });
    let _ = STATE.set(state.clone());

    let db_path = base_dir.join(DB_NAME);
    let db_path_writer = db_path.clone();
    let writer_shutdown = shutdown.clone();
    let session_for_writer = session.clone();
    let writer_handle = thread::spawn(move || run_writer(rx, &db_path_writer, session_for_writer, writer_shutdown));

    ctrlc::set_handler({
        let shutdown = shutdown.clone();
        let main_thread_id = main_thread_id;
        move || {
            signal_shutdown(&shutdown, main_thread_id);
        }
    })
    .context("Failed to set Ctrl+C handler")?;

    send_session_event(&state, "session_start", json!({ "note": "manual_start" }));

    let stop_signal_path = base_dir.join(STOP_FILE);
    let stop_handle = spawn_stop_watcher(state.clone(), stop_signal_path, shutdown.clone(), main_thread_id);
    let snapshot_handle = if config.emit_snapshots {
        Some(spawn_snapshot_loop(
            state.clone(),
            shutdown.clone(),
            config.snapshot_hz,
        ))
    } else {
        None
    };
    let window_poll_handle = if config.window_poll_hz > 0 {
        Some(spawn_window_poll_loop(
            state.clone(),
            shutdown.clone(),
            config.window_poll_hz,
        ))
    } else {
        None
    };

    let (mouse_hook, keyboard_hook) = install_hooks()?;
    let (foreground_hook, location_hook) = install_window_event_hooks()?;

    unsafe {
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND(0), 0, 0).into() {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
            if shutdown.load(Ordering::SeqCst) {
                break;
            }
        }
    }

    flush_text_buffer(&state, "session_end");
    shutdown.store(true, Ordering::SeqCst);
    send_session_event(&state, "session_stop", json!({ "note": "manual_stop" }));
    unsafe {
        let _ = UnhookWindowsHookEx(mouse_hook);
        let _ = UnhookWindowsHookEx(keyboard_hook);
        let _ = UnhookWinEvent(foreground_hook);
        let _ = UnhookWinEvent(location_hook);
    }

    stop_handle.join().ok();
    if let Some(handle) = snapshot_handle {
        handle.join().ok();
    }
    if let Some(handle) = window_poll_handle {
        handle.join().ok();
    }
    writer_handle.join().ok();
    if session.obs_video_path.is_none() {
        if let Some(path) = resolve_obs_video_path(&config, &session) {
            if let Err(err) = update_session_obs_path(&db_path, &session.session_id, &path) {
                eprintln!("Failed to update obs video path: {err}");
            }
        }
    }
    let _ = fs::remove_file(lock_path);
    Ok(())
}

fn stop_recorder() -> Result<()> {
    let base_dir = ensure_app_dir()?;
    let lock_path = base_dir.join(LOCK_FILE);
    if !lock_path.exists() {
        println!("No active recorder session found.");
        return Ok(());
    }
    let stop_path = base_dir.join(STOP_FILE);
    fs::write(stop_path, b"stop")?;
    println!("Stop signal written.");
    if let Some(info) = read_lock_info(&lock_path) {
        if let Some(pid) = info.pid {
            if !is_pid_running(pid) {
                let _ = fs::remove_file(lock_path);
                let _ = fs::remove_file(base_dir.join(STOP_FILE));
                println!("Recorder was not running; stale lock cleared.");
            }
        }
    }
    Ok(())
}

fn print_status() -> Result<()> {
    let base_dir = ensure_app_dir()?;
    let lock_path = base_dir.join(LOCK_FILE);
    if !lock_path.exists() {
        println!("Recorder status: stopped");
        return Ok(());
    }
    if let Some(info) = read_lock_info(&lock_path) {
        if let Some(pid) = info.pid {
            if !is_pid_running(pid) {
                let _ = fs::remove_file(&lock_path);
                println!("Recorder status: stopped (stale lock cleared)");
                return Ok(());
            }
        }
        println!("Recorder status: running");
        if let Some(contents) = info.raw {
            if !contents.trim().is_empty() {
                println!("{contents}");
            }
        }
    } else {
        println!("Recorder status: running");
        let contents = fs::read_to_string(lock_path).unwrap_or_default();
        if !contents.trim().is_empty() {
            println!("{contents}");
        }
    }
    Ok(())
}

fn ensure_app_dir() -> Result<PathBuf> {
    let cwd = env::current_dir().context("Failed to read current dir")?;
    let base_dir = cwd.join(APP_DIR);
    if !base_dir.exists() {
        fs::create_dir_all(&base_dir).context("Failed to create timestone data dir")?;
    }
    Ok(base_dir)
}

fn write_lock(path: &Path, session: &SessionInfo) -> Result<()> {
    let pid = std::process::id();
    let contents = format!(
        "session_id={}\npid={}\nstart_wall_ms={}\nstart_wall_iso={}\n",
        session.session_id, pid, session.start_wall_ms, session.start_wall_iso
    );
    fs::write(path, contents).context("Failed to write lock file")?;
    Ok(())
}

fn signal_shutdown(shutdown: &AtomicBool, main_thread_id: u32) {
    shutdown.store(true, Ordering::SeqCst);
    unsafe {
        let _ = PostThreadMessageW(main_thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
    }
}

struct LockInfo {
    pid: Option<u32>,
    raw: Option<String>,
}

fn read_lock_info(path: &Path) -> Option<LockInfo> {
    let contents = fs::read_to_string(path).ok()?;
    let mut pid = None;
    for line in contents.lines() {
        let mut parts = line.splitn(2, '=');
        let key = parts.next().unwrap_or("").trim();
        let value = parts.next().unwrap_or("").trim();
        if key == "pid" {
            if let Ok(parsed) = value.parse::<u32>() {
                pid = Some(parsed);
            }
        }
    }
    Some(LockInfo {
        pid,
        raw: Some(contents),
    })
}

fn is_pid_running(pid: u32) -> bool {
    let handle = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(handle) => handle,
        Err(_) => return false,
    };
    if handle.is_invalid() {
        return false;
    }
    let mut exit_code: u32 = 0;
    let ok = unsafe { GetExitCodeProcess(handle, &mut exit_code) }.is_ok();
    let _ = unsafe { CloseHandle(handle) };
    if !ok {
        return false;
    }
    exit_code == STILL_ACTIVE.0 as u32
}

struct ComGuard {
    initialized: bool,
}

impl ComGuard {
    fn new(warn_on_fail: bool) -> Self {
        let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok() };
        if warn_on_fail {
            if !initialized {
                eprintln!("Warning: COM init failed, safe text capture disabled.");
            }
        }
        Self { initialized }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                CoUninitialize();
            }
        }
    }
}

fn load_config(base_dir: &Path, overrides: &CliOverrides) -> Result<RecorderConfig> {
    let config_path = overrides
        .config_path
        .clone()
        .unwrap_or_else(|| base_dir.join(CONFIG_FILE));
    let mut config = load_or_create_config(&config_path)?;
    apply_overrides(&mut config, overrides);
    Ok(normalize_config(config))
}

fn load_or_create_config(path: &Path) -> Result<RecorderConfig> {
    if path.exists() {
        let contents = fs::read_to_string(path).context("Failed to read config file")?;
        let config: RecorderConfig =
            serde_json::from_str(&contents).context("Failed to parse config file")?;
        let refreshed = refresh_config_defaults(&config)?;
        return Ok(refreshed);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("Failed to create config directory")?;
    }
    let config = RecorderConfig::default();
    let payload = serde_json::to_string_pretty(&config).context("Failed to serialize config")?;
    fs::write(path, payload).context("Failed to write config file")?;
    Ok(config)
}

fn apply_overrides(config: &mut RecorderConfig, overrides: &CliOverrides) {
    if let Some(mouse_hz) = overrides.mouse_hz {
        config.mouse_hz = mouse_hz;
    }
    if let Some(snapshot_hz) = overrides.snapshot_hz {
        config.snapshot_hz = snapshot_hz;
    }
    if let Some(capture_raw_keys) = overrides.capture_raw_keys {
        config.capture_raw_keys = capture_raw_keys;
    }
    if let Some(obs_video_path) = overrides.obs_video_path.clone() {
        config.obs_video_path = Some(obs_video_path);
    }
    if let Some(obs_video_dir) = overrides.obs_video_dir.clone() {
        config.obs_video_dir = Some(obs_video_dir);
    }
    if let Some(safe_text_only) = overrides.safe_text_only {
        config.safe_text_only = safe_text_only;
    }
}

fn normalize_config(mut config: RecorderConfig) -> RecorderConfig {
    config.mouse_hz = config.mouse_hz.max(1);
    config.snapshot_hz = config.snapshot_hz.max(1);
    config.window_poll_hz = config.window_poll_hz.max(0);
    config.text_flush_ms = config.text_flush_ms.max(250);
    if config.max_text_len < 16 {
        config.max_text_len = 16;
    }
    if let Some(path) = config.obs_video_path.as_ref() {
        if path.trim().is_empty() {
            config.obs_video_path = None;
        }
    }
    if let Some(path) = config.obs_video_dir.as_ref() {
        if path.trim().is_empty() {
            config.obs_video_dir = None;
        }
    }
    config.allowlist_processes = normalize_process_list(config.allowlist_processes);
    config.blocklist_processes = normalize_process_list(config.blocklist_processes);
    config
}

fn resolve_obs_video_path(config: &RecorderConfig, session: &SessionInfo) -> Option<String> {
    if let Some(path) = config.obs_video_path.as_ref() {
        if !path.trim().is_empty() {
            return Some(path.clone());
        }
    }
    let dir = config.obs_video_dir.as_ref()?;
    let dir_path = Path::new(dir);
    if !dir_path.exists() {
        return None;
    }
    let allowed_ext = ["mkv", "mp4", "mov", "webm"];
    let mut candidates: Vec<(i64, String)> = Vec::new();
    let entries = fs::read_dir(dir_path).ok()?;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
        if !allowed_ext.contains(&ext.as_str()) {
            continue;
        }
        let modified = entry.metadata().and_then(|meta| meta.modified()).ok()?;
        let modified_ms = modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
        candidates.push((modified_ms, path.to_string_lossy().to_string()));
    }
    if candidates.is_empty() {
        return None;
    }
    candidates.sort_by_key(|(ms, _)| *ms);
    let best_after_start = candidates
        .iter()
        .rev()
        .find(|(ms, _)| *ms >= session.start_wall_ms)
        .map(|(_, path)| path.clone());
    best_after_start.or_else(|| candidates.last().map(|(_, path)| path.clone()))
}

fn update_session_obs_path(db_path: &Path, session_id: &str, obs_video_path: &str) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "UPDATE sessions SET obs_video_path = ? WHERE session_id = ?",
        params![obs_video_path, session_id],
    )?;
    Ok(())
}

fn parse_raw_keys_mode(value: &str) -> RawKeysMode {
    match value.trim().to_ascii_lowercase().as_str() {
        "up" => RawKeysMode::Up,
        "both" => RawKeysMode::Both,
        _ => RawKeysMode::Down,
    }
}

fn normalize_process_list(list: Vec<String>) -> Vec<String> {
    list.into_iter()
        .filter_map(|entry| {
            let trimmed = entry.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_ascii_lowercase())
            }
        })
        .collect()
}

fn refresh_config_defaults(config: &RecorderConfig) -> Result<RecorderConfig> {
    let mut default_value = serde_json::to_value(RecorderConfig::default())
        .context("Failed to serialize default config")?;
    let user_value = serde_json::to_value(config).context("Failed to serialize user config")?;
    merge_config_value(&mut default_value, &user_value);
    serde_json::from_value(default_value).context("Failed to merge config defaults")
}

fn merge_config_value(target: &mut Value, source: &Value) {
    match (target, source) {
        (Value::Object(target_map), Value::Object(source_map)) => {
            for (key, value) in source_map {
                match target_map.get_mut(key) {
                    Some(existing) => merge_config_value(existing, value),
                    None => {
                        target_map.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (target_value, source_value) => {
            *target_value = source_value.clone();
        }
    }
}

fn spawn_stop_watcher(
    state: Arc<RecorderState>,
    stop_path: PathBuf,
    shutdown: Arc<AtomicBool>,
    main_thread_id: u32,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let interval = Duration::from_millis(200);
        while !shutdown.load(Ordering::SeqCst) {
            if stop_path.exists() {
                let _ = fs::remove_file(&stop_path);
                flush_text_buffer(&state, "stop_signal");
                signal_shutdown(&shutdown, main_thread_id);
                break;
            }
            flush_text_buffer_if_stale(&state, "idle_timeout");
            thread::sleep(interval);
        }
    })
}

fn spawn_snapshot_loop(
    state: Arc<RecorderState>,
    shutdown: Arc<AtomicBool>,
    snapshot_hz: u64,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let interval = Duration::from_millis(1000 / snapshot_hz.max(1));
        while !shutdown.load(Ordering::SeqCst) {
            if let Some(snapshot) = build_snapshot(&state) {
                state.sender.try_send(snapshot).ok();
            }
            thread::sleep(interval);
        }
    })
}

fn spawn_window_poll_loop(
    state: Arc<RecorderState>,
    shutdown: Arc<AtomicBool>,
    window_poll_hz: u64,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let interval = Duration::from_millis(1000 / window_poll_hz.max(1));
        while !shutdown.load(Ordering::SeqCst) {
            poll_active_window(&state);
            thread::sleep(interval);
        }
    })
}

fn install_hooks() -> Result<(HHOOK, HHOOK)> {
    unsafe {
        let module = GetModuleHandleW(None).unwrap_or(HMODULE::default());
        let mouse_hook =
            SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), module, 0).context("Failed to install mouse hook")?;
        if mouse_hook.0 == 0 {
            anyhow::bail!("Failed to install mouse hook");
        }
        let keyboard_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook_proc), module, 0)
            .context("Failed to install keyboard hook")?;
        if keyboard_hook.0 == 0 {
            let _ = UnhookWindowsHookEx(mouse_hook);
            anyhow::bail!("Failed to install keyboard hook");
        }
        Ok((mouse_hook, keyboard_hook))
    }
}

fn install_window_event_hooks() -> Result<(HWINEVENTHOOK, HWINEVENTHOOK)> {
    unsafe {
        let foreground = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            HMODULE::default(),
            Some(win_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        if foreground.0 == 0 {
            anyhow::bail!("Failed to install foreground event hook");
        }

        let location = SetWinEventHook(
            EVENT_OBJECT_LOCATIONCHANGE,
            EVENT_OBJECT_LOCATIONCHANGE,
            HMODULE::default(),
            Some(win_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
        if location.0 == 0 {
            let _ = UnhookWinEvent(foreground);
            anyhow::bail!("Failed to install location event hook");
        }

        Ok((foreground, location))
    }
}

fn build_snapshot(state: &RecorderState) -> Option<EventRecord> {
    let (x, y) = cursor_position()?;
    let window_info = active_window_info().map(|(_, info)| info);
    let mouse = MouseInfo {
        x,
        y,
        button: None,
        delta: None,
    };
    Some(EventRecord {
        session_id: state.session_id.clone(),
        ts_wall_ms: now_wall_ms(),
        ts_mono_ms: now_mono_ms(state),
        event_type: "snapshot".to_string(),
        process_name: window_info.as_ref().and_then(|info| info.process_name.clone()),
        window_title: window_info.as_ref().map(|info| info.title.clone()),
        window_class: window_info.as_ref().map(|info| info.class_name.clone()),
        window_rect: window_info.as_ref().and_then(|info| info.rect.clone()),
        mouse: Some(mouse),
        payload: json!({}),
    })
}

fn send_session_event(state: &RecorderState, event_type: &str, payload: Value) {
    let event = EventRecord {
        session_id: state.session_id.clone(),
        ts_wall_ms: now_wall_ms(),
        ts_mono_ms: now_mono_ms(state),
        event_type: event_type.to_string(),
        process_name: None,
        window_title: None,
        window_class: None,
        window_rect: None,
        mouse: None,
        payload,
    };
    state.sender.try_send(event).ok();
}

fn now_wall_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn now_mono_ms(state: &RecorderState) -> i64 {
    state.start_instant.elapsed().as_millis() as i64
}

#[derive(Clone)]
struct WindowInfo {
    title: String,
    class_name: String,
    rect: Option<RectInfo>,
    process_name: Option<String>,
}

struct WindowTracker {
    last_hwnd: HWND,
    last_rect: Option<RectInfo>,
}

fn cursor_position() -> Option<(i32, i32)> {
    unsafe {
        let mut pt = POINT::default();
        if windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut pt).is_ok() {
            Some((pt.x, pt.y))
        } else {
            None
        }
    }
}

fn active_window_info() -> Option<(HWND, WindowInfo)> {
    unsafe {
        let hwnd = GetForegroundWindow();
        window_info_for_hwnd(hwnd).map(|info| (hwnd, info))
    }
}

fn window_info_for_hwnd(hwnd: HWND) -> Option<WindowInfo> {
    if hwnd.0 == 0 {
        return None;
    }
    let title = get_window_text(hwnd);
    let class_name = get_window_class(hwnd);
    let rect = get_window_rect(hwnd);
    let process_name = get_process_name(hwnd);
    Some(WindowInfo {
        title,
        class_name,
        rect,
        process_name,
    })
}

fn get_window_text(hwnd: HWND) -> String {
    let mut buffer = vec![0u16; 512];
    unsafe {
        let len = GetWindowTextW(hwnd, &mut buffer);
        if len == 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..len as usize])
    }
}

fn get_window_class(hwnd: HWND) -> String {
    let mut buffer = vec![0u16; 256];
    unsafe {
        let len = GetClassNameW(hwnd, &mut buffer);
        if len == 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..len as usize])
    }
}

fn get_window_rect(hwnd: HWND) -> Option<RectInfo> {
    unsafe {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_ok() {
            Some(RectInfo {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
            })
        } else {
            None
        }
    }
}

fn get_process_name(hwnd: HWND) -> Option<String> {
    unsafe {
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let handle = match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => handle,
            Err(_) => return None,
        };
        if handle.is_invalid() {
            return None;
        }
        let mut buffer = vec![0u16; 512];
        let mut size: u32 = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }
}

fn poll_active_window(state: &RecorderState) {
    if let Some((hwnd, window_info)) = active_window_info() {
        update_window_events(state, hwnd, window_info);
    }
}

fn update_window_events(state: &RecorderState, hwnd: HWND, window_info: WindowInfo) {
    let (is_new, rect_changed) = {
        let mut tracker = state.window_tracker.lock().unwrap();
        let is_new = hwnd != tracker.last_hwnd;
        let rect_changed = is_new || window_info.rect != tracker.last_rect;
        tracker.last_hwnd = hwnd;
        tracker.last_rect = window_info.rect.clone();
        (is_new, rect_changed)
    };

    if is_new {
        flush_text_buffer_with_window(state, Some(window_info.clone()), "window_change");
        send_active_window_changed(state, &window_info);
    }
    if rect_changed && !is_new {
        send_window_rect_changed(state, &window_info);
    }
}

fn send_active_window_changed(state: &RecorderState, window_info: &WindowInfo) {
    let event = EventRecord {
        session_id: state.session_id.clone(),
        ts_wall_ms: now_wall_ms(),
        ts_mono_ms: now_mono_ms(state),
        event_type: "active_window_changed".to_string(),
        process_name: window_info.process_name.clone(),
        window_title: Some(window_info.title.clone()),
        window_class: Some(window_info.class_name.clone()),
        window_rect: window_info.rect.clone(),
        mouse: None,
        payload: json!({}),
    };
    state.sender.try_send(event).ok();
}

fn send_window_rect_changed(state: &RecorderState, window_info: &WindowInfo) {
    let event = EventRecord {
        session_id: state.session_id.clone(),
        ts_wall_ms: now_wall_ms(),
        ts_mono_ms: now_mono_ms(state),
        event_type: "window_rect_changed".to_string(),
        process_name: window_info.process_name.clone(),
        window_title: Some(window_info.title.clone()),
        window_class: Some(window_info.class_name.clone()),
        window_rect: window_info.rect.clone(),
        mouse: None,
        payload: json!({}),
    };
    state.sender.try_send(event).ok();
}

fn send_marker_event(state: &RecorderState, hotkey: &str) {
    let window_info = active_window_info().map(|(_, info)| info);
    let (process_name, window_title, window_class, window_rect) = match window_info {
        Some(info) => (
            info.process_name.clone(),
            Some(info.title.clone()),
            Some(info.class_name.clone()),
            info.rect.clone(),
        ),
        None => (None, None, None, None),
    };
    let event = EventRecord {
        session_id: state.session_id.clone(),
        ts_wall_ms: now_wall_ms(),
        ts_mono_ms: now_mono_ms(state),
        event_type: "marker".to_string(),
        process_name,
        window_title,
        window_class,
        window_rect,
        mouse: None,
        payload: json!({
            "hotkey": hotkey,
        }),
    };
    state.sender.try_send(event).ok();
}

unsafe extern "system" fn win_event_proc(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    _id_child: i32,
    _event_thread: u32,
    _event_time: u32,
) {
    if id_object != OBJID_WINDOW.0 {
        return;
    }
    let Some(state) = STATE.get() else {
        return;
    };
    match event {
        EVENT_SYSTEM_FOREGROUND => {
            if let Some(window_info) = window_info_for_hwnd(hwnd) {
                update_window_events(state, hwnd, window_info);
            }
        }
        EVENT_OBJECT_LOCATIONCHANGE => {
            let foreground = GetForegroundWindow();
            if hwnd != foreground {
                return;
            }
            if let Some(window_info) = window_info_for_hwnd(hwnd) {
                update_window_events(state, hwnd, window_info);
            }
        }
        _ => {}
    }
}

unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == 0 {
        if let Some(state) = STATE.get() {
            let data = *(lparam.0 as *const MSLLHOOKSTRUCT);
            let (event_type, button, delta) = match wparam.0 as u32 {
                WM_MOUSEMOVE => ("mouse_move", None, None),
                WM_LBUTTONDOWN => ("mouse_click", Some("left_down"), None),
                WM_LBUTTONUP => ("mouse_click", Some("left_up"), None),
                WM_RBUTTONDOWN => ("mouse_click", Some("right_down"), None),
                WM_RBUTTONUP => ("mouse_click", Some("right_up"), None),
                WM_MBUTTONDOWN => ("mouse_click", Some("middle_down"), None),
                WM_MBUTTONUP => ("mouse_click", Some("middle_up"), None),
                WM_MOUSEWHEEL => {
                    let delta = ((data.mouseData >> 16) & 0xffff) as i16 as i32;
                    ("mouse_scroll", None, Some(delta))
                }
                _ => ("unknown", None, None),
            };

            if event_type != "unknown" {
                if event_type == "mouse_move" && !state.emit_mouse_move {
                    return CallNextHookEx(HHOOK(0), code, wparam, lparam);
                }
                if event_type == "mouse_scroll" && !state.emit_mouse_scroll {
                    return CallNextHookEx(HHOOK(0), code, wparam, lparam);
                }
                let mono_ms = now_mono_ms(state);
                if event_type == "mouse_move" {
                    let last = state.last_mouse_move_ms.load(Ordering::SeqCst);
                    if last >= 0 && mono_ms - last < state.mouse_move_interval_ms {
                        return CallNextHookEx(HHOOK(0), code, wparam, lparam);
                    }
                    state.last_mouse_move_ms.store(mono_ms, Ordering::SeqCst);
                }

                let mouse = MouseInfo {
                    x: data.pt.x,
                    y: data.pt.y,
                    button: button.map(|b| b.to_string()),
                    delta,
                };
                let event = EventRecord {
                    session_id: state.session_id.clone(),
                    ts_wall_ms: now_wall_ms(),
                    ts_mono_ms: mono_ms,
                    event_type: event_type.to_string(),
                    process_name: None,
                    window_title: None,
                    window_class: None,
                    window_rect: None,
                    mouse: Some(mouse),
                    payload: json!({}),
                };
                state.sender.try_send(event).ok();
            }
        }
    }
    CallNextHookEx(HHOOK(0), code, wparam, lparam)
}

unsafe extern "system" fn keyboard_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == 0 {
        if let Some(state) = STATE.get() {
            let data = *(lparam.0 as *const KBDLLHOOKSTRUCT);
            let vk = data.vkCode;
            let is_down = matches!(wparam.0 as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            let is_up = matches!(wparam.0 as u32, WM_KEYUP | WM_SYSKEYUP);

            if is_down || is_up {
                let mut pressed = state.pressed_keys.lock().unwrap();
                let was_pressed = pressed.contains(&vk);
                if is_down {
                    pressed.insert(vk);
                } else {
                    pressed.remove(&vk);
                }

                let modifiers = current_modifiers(&pressed);
                let is_modifier = is_modifier_key(vk);
                let is_chorded = !is_modifier && !modifiers.is_empty();
                let has_ctrl = pressed.contains(&(VK_CONTROL.0 as u32))
                    || pressed.contains(&(VK_LCONTROL.0 as u32))
                    || pressed.contains(&(VK_RCONTROL.0 as u32));
                let has_shift = pressed.contains(&(VK_SHIFT.0 as u32))
                    || pressed.contains(&(VK_LSHIFT.0 as u32))
                    || pressed.contains(&(VK_RSHIFT.0 as u32));
                let has_alt = pressed.contains(&(VK_MENU.0 as u32))
                    || pressed.contains(&(VK_LMENU.0 as u32))
                    || pressed.contains(&(VK_RMENU.0 as u32));
                let has_win =
                    pressed.contains(&(VK_LWIN.0 as u32)) || pressed.contains(&(VK_RWIN.0 as u32));
                if is_down && is_chorded {
                    let event = EventRecord {
                        session_id: state.session_id.clone(),
                        ts_wall_ms: now_wall_ms(),
                        ts_mono_ms: now_mono_ms(state),
                        event_type: "key_shortcut".to_string(),
                        process_name: None,
                        window_title: None,
                        window_class: None,
                        window_rect: None,
                        mouse: None,
                        payload: json!({
                            "key": vk_to_name(vk),
                            "modifiers": modifiers,
                        }),
                    };
                    state.sender.try_send(event).ok();
                }

                let is_marker_hotkey =
                    is_down && !was_pressed && vk == 0x30 && has_ctrl && !has_alt && !has_win && !has_shift;
                if is_marker_hotkey {
                    flush_text_buffer(state, "marker");
                    send_marker_event(state, "Ctrl+0");
                }

                if is_down && !is_modifier && !has_ctrl && !has_alt && !has_win {
                    let window_info = active_window_info().map(|(_, info)| info);
                    if !should_capture_text(state, window_info.as_ref()) {
                        flush_text_buffer_with_window(state, window_info, "unsafe_target");
                    } else {
                        handle_text_key(state, window_info, vk, data.scanCode);
                    }
                }

                if state.capture_raw_keys
                    && ((is_down && state.raw_keys_mode != RawKeysMode::Up)
                        || (is_up && state.raw_keys_mode != RawKeysMode::Down))
                    && !(state.suppress_raw_keys_on_shortcut && is_chorded)
                {
                    let event = EventRecord {
                        session_id: state.session_id.clone(),
                        ts_wall_ms: now_wall_ms(),
                        ts_mono_ms: now_mono_ms(state),
                        event_type: if is_down { "key_down" } else { "key_up" }.to_string(),
                        process_name: None,
                        window_title: None,
                        window_class: None,
                        window_rect: None,
                        mouse: None,
                        payload: json!({
                            "key": vk_to_name(vk),
                            "vk": vk,
                        }),
                    };
                    state.sender.try_send(event).ok();
                }
            }
        }
    }
    CallNextHookEx(HHOOK(0), code, wparam, lparam)
}

fn current_modifiers(pressed: &HashSet<u32>) -> Vec<String> {
    let mut mods = Vec::new();
    if pressed.contains(&(VK_CONTROL.0 as u32))
        || pressed.contains(&(VK_LCONTROL.0 as u32))
        || pressed.contains(&(VK_RCONTROL.0 as u32))
    {
        mods.push("Ctrl".to_string());
    }
    if pressed.contains(&(VK_SHIFT.0 as u32))
        || pressed.contains(&(VK_LSHIFT.0 as u32))
        || pressed.contains(&(VK_RSHIFT.0 as u32))
    {
        mods.push("Shift".to_string());
    }
    if pressed.contains(&(VK_MENU.0 as u32)) || pressed.contains(&(VK_LMENU.0 as u32)) || pressed.contains(&(VK_RMENU.0 as u32)) {
        mods.push("Alt".to_string());
    }
    if pressed.contains(&(VK_LWIN.0 as u32)) || pressed.contains(&(VK_RWIN.0 as u32)) {
        mods.push("Win".to_string());
    }
    mods
}

fn is_modifier_key(vk: u32) -> bool {
    matches!(
        vk,
        x if x == VK_CONTROL.0 as u32
            || x == VK_LCONTROL.0 as u32
            || x == VK_RCONTROL.0 as u32
            || x == VK_SHIFT.0 as u32
            || x == VK_LSHIFT.0 as u32
            || x == VK_RSHIFT.0 as u32
            || x == VK_MENU.0 as u32
            || x == VK_LMENU.0 as u32
            || x == VK_RMENU.0 as u32
            || x == VK_LWIN.0 as u32
            || x == VK_RWIN.0 as u32
    )
}

fn vk_to_name(vk: u32) -> String {
    match vk {
        0x08 => "Backspace".to_string(),
        0x09 => "Tab".to_string(),
        0x0D => "Enter".to_string(),
        0x1B => "Esc".to_string(),
        0x20 => "Space".to_string(),
        0x25 => "Left".to_string(),
        0x26 => "Up".to_string(),
        0x27 => "Right".to_string(),
        0x28 => "Down".to_string(),
        0x2E => "Delete".to_string(),
        0x30..=0x39 => ((vk as u8) as char).to_string(),
        0x41..=0x5A => ((vk as u8) as char).to_string(),
        0x70..=0x7B => format!("F{}", vk - 0x6F),
        _ => format!("VK_{vk:02X}"),
    }
}

fn get_uia() -> Option<IUIAutomation> {
    UIA.with(|cell| {
        let mut stored = cell.borrow_mut();
        if stored.is_none() {
            if let Ok(automation) = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
                *stored = Some(automation);
            }
        }
        stored.clone()
    })
}

fn should_capture_text(state: &RecorderState, window_info: Option<&WindowInfo>) -> bool {
    let process_name = window_info.and_then(|info| info.process_name.as_deref());
    if process_is_blocked(state, process_name) {
        return false;
    }
    if !process_is_allowed(state, process_name) {
        return false;
    }
    if !state.safe_text_only {
        return true;
    }
    let Some(uia) = get_uia() else {
        return false;
    };
    let element = match unsafe { uia.GetFocusedElement() } {
        Ok(element) => element,
        Err(_) => return false,
    };
    let has_focus = unsafe { element.CurrentHasKeyboardFocus() }
        .ok()
        .map(|value| value.as_bool())
        .unwrap_or(false);
    if !has_focus {
        return false;
    }
    let is_password = unsafe { element.CurrentIsPassword() }
        .ok()
        .map(|value| value.as_bool())
        .unwrap_or(false);
    if is_password {
        return false;
    }
    let control_type = unsafe { element.CurrentControlType() }.unwrap_or(UIA_CONTROLTYPE_ID(0));
    if control_type != UIA_EditControlTypeId && control_type != UIA_DocumentControlTypeId {
        return false;
    }
    true
}

fn process_is_allowed(state: &RecorderState, process_name: Option<&str>) -> bool {
    if state.allowlist_processes.is_empty() {
        return true;
    }
    let Some(name) = process_name else {
        return false;
    };
    let normalized = normalize_process_name(name);
    state.allowlist_processes.iter().any(|entry| entry == &normalized)
}

fn process_is_blocked(state: &RecorderState, process_name: Option<&str>) -> bool {
    if state.blocklist_processes.is_empty() {
        return false;
    }
    let Some(name) = process_name else {
        return false;
    };
    let normalized = normalize_process_name(name);
    state.blocklist_processes.iter().any(|entry| entry == &normalized)
}

fn normalize_process_name(process_name: &str) -> String {
    Path::new(process_name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(process_name)
        .to_ascii_lowercase()
}

fn handle_text_key(state: &RecorderState, window_info: Option<WindowInfo>, vk: u32, scan_code: u32) {
    let now_ms = now_mono_ms(state);
    flush_text_buffer_if_stale_with_window(state, window_info.clone(), now_ms, "timeout");

    if vk == VK_BACK.0 as u32 {
        let mut buffer = state.text_buffer.lock().unwrap();
        if buffer.text.pop().is_some() {
            buffer.last_ts_ms = now_ms;
        }
        return;
    }
    if vk == VK_RETURN.0 as u32 {
        flush_text_buffer_with_window(state, window_info, "enter");
        return;
    }
    if vk == VK_TAB.0 as u32 {
        flush_text_buffer_with_window(state, window_info, "tab");
        return;
    }

    let Some(text) = translate_vk_to_text(vk, scan_code) else {
        return;
    };
    if text.is_empty() {
        return;
    }
    let should_flush = {
        let mut buffer = state.text_buffer.lock().unwrap();
        buffer.text.push_str(&text);
        buffer.last_ts_ms = now_ms;
        buffer.text.len() >= state.max_text_len
    };
    if should_flush {
        flush_text_buffer_with_window(state, window_info, "max_len");
    }
}

fn translate_vk_to_text(vk: u32, scan_code: u32) -> Option<String> {
    unsafe {
        let mut key_state = [0u8; 256];
        if GetKeyboardState(&mut key_state).is_err() {
            return None;
        }
        let layout = GetKeyboardLayout(0);
        let mut buffer = [0u16; 8];
        let written = ToUnicodeEx(vk, scan_code, &key_state, &mut buffer, 0, layout);
        if written <= 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buffer[..written as usize]))
    }
}

fn flush_text_buffer_if_stale(state: &RecorderState, reason: &str) {
    let now_ms = now_mono_ms(state);
    let should_flush = {
        let buffer = state.text_buffer.lock().unwrap();
        !buffer.text.is_empty() && now_ms - buffer.last_ts_ms >= state.text_flush_ms
    };
    if should_flush {
        flush_text_buffer(state, reason);
    }
}

fn flush_text_buffer_if_stale_with_window(
    state: &RecorderState,
    window_info: Option<WindowInfo>,
    now_ms: i64,
    reason: &str,
) {
    let should_flush = {
        let buffer = state.text_buffer.lock().unwrap();
        !buffer.text.is_empty() && now_ms - buffer.last_ts_ms >= state.text_flush_ms
    };
    if should_flush {
        flush_text_buffer_with_window(state, window_info, reason);
    }
}

fn flush_text_buffer(state: &RecorderState, reason: &str) {
    let window_info = active_window_info().map(|(_, info)| info);
    flush_text_buffer_with_window(state, window_info, reason);
}

fn flush_text_buffer_with_window(state: &RecorderState, window_info: Option<WindowInfo>, reason: &str) {
    let now_ms = now_mono_ms(state);
    let text = {
        let mut buffer = state.text_buffer.lock().unwrap();
        if buffer.text.is_empty() {
            return;
        }
        buffer.last_ts_ms = now_ms;
        std::mem::take(&mut buffer.text)
    };
    send_text_event(state, window_info, text, reason);
}

fn send_text_event(state: &RecorderState, window_info: Option<WindowInfo>, text: String, reason: &str) {
    let (process_name, window_title, window_class, window_rect) = match window_info {
        Some(info) => (
            info.process_name.clone(),
            Some(info.title.clone()),
            Some(info.class_name.clone()),
            info.rect.clone(),
        ),
        None => (None, None, None, None),
    };
    let event = EventRecord {
        session_id: state.session_id.clone(),
        ts_wall_ms: now_wall_ms(),
        ts_mono_ms: now_mono_ms(state),
        event_type: "text_input".to_string(),
        process_name,
        window_title,
        window_class,
        window_rect,
        mouse: None,
        payload: json!({
            "text": text,
            "reason": reason,
        }),
    };
    state.sender.try_send(event).ok();
}

fn run_writer(rx: Receiver<EventRecord>, db_path: &Path, session: SessionInfo, shutdown: Arc<AtomicBool>) {
    let mut conn = match Connection::open(db_path) {
        Ok(conn) => conn,
        Err(err) => {
            eprintln!("DB open failed: {err}");
            return;
        }
    };
    if let Err(err) = init_db(&conn) {
        eprintln!("DB init failed: {err}");
        return;
    }
    if let Err(err) = insert_session(&conn, &session) {
        eprintln!("Session insert failed: {err}");
        return;
    }

    let mut buffer: Vec<EventRecord> = Vec::with_capacity(200);
    let flush_interval = Duration::from_millis(250);
    loop {
        match rx.recv_timeout(flush_interval) {
            Ok(event) => {
                buffer.push(event);
                if buffer.len() >= 200 {
                    if let Err(err) = flush_events(&mut conn, &buffer) {
                        eprintln!("Event flush failed: {err}");
                    }
                    buffer.clear();
                }
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                if !buffer.is_empty() {
                    if let Err(err) = flush_events(&mut conn, &buffer) {
                        eprintln!("Event flush failed: {err}");
                    }
                    buffer.clear();
                }
                if shutdown.load(Ordering::SeqCst) && rx.is_empty() {
                    break;
                }
            }
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn init_db(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT UNIQUE,
            start_wall_ms INTEGER,
            start_wall_iso TEXT,
            obs_video_path TEXT
        );
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            ts_wall_ms INTEGER,
            ts_mono_ms INTEGER,
            event_type TEXT,
            process_name TEXT,
            window_title TEXT,
            window_class TEXT,
            window_rect TEXT,
            mouse TEXT,
            payload TEXT,
            FOREIGN KEY(session_id) REFERENCES sessions(session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_events_session_time ON events(session_id, ts_mono_ms);
        CREATE INDEX IF NOT EXISTS idx_events_session_type ON events(session_id, event_type);
        ",
    )?;
    Ok(())
}

fn insert_session(conn: &Connection, session: &SessionInfo) -> Result<()> {
    conn.execute(
        "INSERT INTO sessions (session_id, start_wall_ms, start_wall_iso, obs_video_path) VALUES (?, ?, ?, ?)",
        params![
            session.session_id,
            session.start_wall_ms,
            session.start_wall_iso,
            session.obs_video_path
        ],
    )?;
    Ok(())
}

fn flush_events(conn: &mut Connection, events: &[EventRecord]) -> Result<()> {
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO events (
                session_id, ts_wall_ms, ts_mono_ms, event_type, process_name, window_title, window_class, window_rect, mouse, payload
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )?;

        for event in events {
            let window_rect = event
                .window_rect
                .as_ref()
                .and_then(|rect| serde_json::to_string(rect).ok());
            let mouse = event
                .mouse
                .as_ref()
                .and_then(|m| serde_json::to_string(m).ok());
            let payload = serde_json::to_string(&event.payload).unwrap_or_else(|_| "{}".to_string());

            stmt.execute(params![
                event.session_id,
                event.ts_wall_ms,
                event.ts_mono_ms,
                event.event_type,
                event.process_name,
                event.window_title,
                event.window_class,
                window_rect,
                mouse,
                payload,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}
