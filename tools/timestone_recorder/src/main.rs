use anyhow::{Context, Result};
use chrono::{DateTime, Local};
use crossbeam_channel::{bounded, Receiver, Sender};
use once_cell::sync::OnceCell;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, hash_map::DefaultHasher};
use std::env;
use std::ffi::c_void;
use std::fs;
use std::io::Write;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HGLOBAL, HMODULE, HWND, LPARAM, LRESULT, POINT, RECT, STILL_ACTIVE, WPARAM};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Threading::{
    GetCurrentThreadId, GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyboardLayout, GetKeyboardState, ToUnicodeEx, VK_BACK, VK_CONTROL, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN,
    VK_MENU, VK_RCONTROL, VK_RETURN, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT, VK_TAB,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationValuePattern, SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK,
    UIA_CONTROLTYPE_ID, UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_ValuePatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DestroyIcon, DispatchMessageW, GetClassNameW, GetForegroundWindow, GetIconInfo, GetMessageW,
    GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, PostThreadMessageW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, ICONINFO, EVENT_OBJECT_LOCATIONCHANGE, EVENT_SYSTEM_FOREGROUND, HHOOK, KBDLLHOOKSTRUCT, MSG,
    MSLLHOOKSTRUCT, OBJID_WINDOW, WH_KEYBOARD_LL, WH_MOUSE_LL, WINEVENT_OUTOFCONTEXT, WM_KEYDOWN, WM_KEYUP,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_QUIT, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN,
    WM_RBUTTONUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP, SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
use windows::Win32::Graphics::Gdi::{
    BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW,
    SelectObject, DIB_RGB_COLORS,
};

const APP_DIR: &str = "data\\timestone";
const DB_NAME: &str = "timestone_events.sqlite3";
const LOCK_FILE: &str = "recorder.lock";
const STOP_FILE: &str = "stop.signal";
const PAUSE_FILE: &str = "pause.signal";
const RELOAD_CONFIG_FILE: &str = "reload_config.signal";
const CONFIG_FILE: &str = "config.json";
const CLIPBOARD_DIR: &str = "clipboard";
const ICONS_DIR: &str = "icons";

const CLIPBOARD_CF_DIB: u32 = 8;
const CLIPBOARD_CF_DIBV5: u32 = 17;
const CLIPBOARD_CF_HDROP: u32 = 15;
const CLIPBOARD_CF_UNICODETEXT: u32 = 13;

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
    emit_mouse_click: bool,
    mouse_click_mode: String,
    emit_mouse_scroll: bool,
    capture_clipboard: bool,
    clipboard_poll_ms: u64,
    clipboard_debounce_ms: u64,
    clipboard_dedupe_window_ms: u64,
    window_poll_hz: u64,
    window_rect_debounce_ms: u64,
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
    text_snapshot_on_idle: bool,
}

impl Default for RecorderConfig {
    fn default() -> Self {
        Self {
            mouse_hz: 30,
            snapshot_hz: 1,
            emit_snapshots: false,
            emit_mouse_move: false,
            emit_mouse_click: true,
            mouse_click_mode: "down".to_string(),
            emit_mouse_scroll: false,
            capture_clipboard: true,
            clipboard_poll_ms: 250,
            clipboard_debounce_ms: 200,
            clipboard_dedupe_window_ms: 2000,
            window_poll_hz: 0,
            window_rect_debounce_ms: 300,
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
            text_snapshot_on_idle: false,
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
    paused: AtomicBool,
    capture_raw_keys: bool,
    raw_keys_mode: RawKeysMode,
    suppress_raw_keys_on_shortcut: bool,
    emit_mouse_move: AtomicBool,
    emit_mouse_click: AtomicBool,
    emit_mouse_scroll: AtomicBool,
    mouse_click_mode: MouseClickMode,
    pressed_keys: Mutex<HashSet<u32>>,
    safe_text_only: bool,
    allowlist_processes: Vec<String>,
    blocklist_processes: Vec<String>,
    text_flush_ms: i64,
    max_text_len: usize,
    text_buffer: Mutex<TextBuffer>,
    text_snapshot_on_idle: bool,
    clipboard_dedupe_window_ms: i64,
    last_clipboard_hash: Mutex<Option<ClipboardHash>>,
    app_icon_cache: Mutex<HashMap<String, String>>,
    icons_dir: PathBuf,
    window_rect_debounce_ms: i64,
    window_tracker: Mutex<WindowTracker>,
    scroll_buffer: Mutex<Option<ScrollBuffer>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RawKeysMode {
    Down,
    Up,
    Both,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MouseClickMode {
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

struct ClipboardImage {
    path: String,
    width: i32,
    height: i32,
}

struct ClipboardHash {
    hash: u64,
    ts_ms: i64,
}

struct ScrollBuffer {
    last_ts_ms: i64,
    x: i32,
    y: i32,
    total_delta: i32,
    ticks: i32,
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
        Some("pause") => {
            pause_recorder()?;
        }
        Some("resume") => {
            resume_recorder()?;
        }
        Some("toggle") => {
            toggle_pause()?;
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
    println!("  timestone_recorder pause");
    println!("  timestone_recorder resume");
    println!("  timestone_recorder toggle");
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

    let icons_dir = base_dir.join(ICONS_DIR);
    if !icons_dir.exists() {
        fs::create_dir_all(&icons_dir).context("Failed to create icons dir")?;
    }

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
        paused: AtomicBool::new(false),
        capture_raw_keys: config.capture_raw_keys,
        raw_keys_mode: parse_raw_keys_mode(&config.raw_keys_mode),
        suppress_raw_keys_on_shortcut: config.suppress_raw_keys_on_shortcut,
        emit_mouse_move: AtomicBool::new(config.emit_mouse_move),
        emit_mouse_click: AtomicBool::new(config.emit_mouse_click),
        emit_mouse_scroll: AtomicBool::new(config.emit_mouse_scroll),
        mouse_click_mode: parse_mouse_click_mode(&config.mouse_click_mode),
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
        text_snapshot_on_idle: config.text_snapshot_on_idle,
        clipboard_dedupe_window_ms: config.clipboard_dedupe_window_ms as i64,
        last_clipboard_hash: Mutex::new(None),
        app_icon_cache: Mutex::new(HashMap::new()),
        icons_dir: icons_dir.clone(),
        window_rect_debounce_ms: config.window_rect_debounce_ms as i64,
        window_tracker: Mutex::new(WindowTracker {
            last_hwnd: HWND(0),
            last_rect: None,
            pending_rect: None,
        }),
        scroll_buffer: Mutex::new(None),
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
    let pause_signal_path = base_dir.join(PAUSE_FILE);
    let pause_handle = spawn_pause_watcher(state.clone(), pause_signal_path, shutdown.clone());
    let scroll_flush_handle = spawn_scroll_flush(state.clone(), shutdown.clone());
    let reload_signal_path = base_dir.join(RELOAD_CONFIG_FILE);
    let reload_handle = spawn_config_reload_watcher(
        state.clone(),
        reload_signal_path,
        base_dir.clone(),
        shutdown.clone(),
    );
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
    let clipboard_handle = if config.capture_clipboard {
        Some(spawn_clipboard_loop(
            state.clone(),
            shutdown.clone(),
            config.clipboard_poll_ms,
            config.clipboard_debounce_ms,
            base_dir.clone(),
        ))
    } else {
        None
    };
    let rect_flush_handle = if config.window_rect_debounce_ms > 0 {
        Some(spawn_window_rect_flush_loop(state.clone(), shutdown.clone()))
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
    pause_handle.join().ok();
    scroll_flush_handle.join().ok();
    reload_handle.join().ok();
    if let Some(handle) = snapshot_handle {
        handle.join().ok();
    }
    if let Some(handle) = window_poll_handle {
        handle.join().ok();
    }
    if let Some(handle) = rect_flush_handle {
        handle.join().ok();
    }
    if let Some(handle) = clipboard_handle {
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
    let pause_path = base_dir.join(PAUSE_FILE);
    let _ = fs::remove_file(pause_path);
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

fn spawn_pause_watcher(
    state: Arc<RecorderState>,
    pause_path: PathBuf,
    shutdown: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let interval = Duration::from_millis(200);
        let mut last_paused = false;
        while !shutdown.load(Ordering::SeqCst) {
            let paused = pause_path.exists();
            if paused != last_paused {
                state.paused.store(paused, Ordering::SeqCst);
                if paused {
                    flush_text_buffer(&state, "pause");
                    send_session_event(&state, "session_pause", json!({ "note": "pause_signal" }));
                } else {
                    send_session_event(&state, "session_resume", json!({ "note": "pause_signal" }));
                }
                last_paused = paused;
            }
            thread::sleep(interval);
        }
    })
}

fn spawn_config_reload_watcher(
    state: Arc<RecorderState>,
    reload_path: PathBuf,
    base_dir: PathBuf,
    shutdown: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let interval = Duration::from_millis(250);
        while !shutdown.load(Ordering::SeqCst) {
            if reload_path.exists() {
                let _ = fs::remove_file(&reload_path);
                if let Ok(config) = load_or_create_config(&base_dir.join(CONFIG_FILE)) {
                    let config = normalize_config(config);
                    apply_capture_flags(&state, &config);
                }
            }
            thread::sleep(interval);
        }
    })
}

fn spawn_scroll_flush(
    state: Arc<RecorderState>,
    shutdown: Arc<AtomicBool>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let interval = Duration::from_millis(120);
        while !shutdown.load(Ordering::SeqCst) {
            {
                let mut buffer = state.scroll_buffer.lock().unwrap();
                if let Some(existing) = buffer.as_ref() {
                    if now_mono_ms(&state) - existing.last_ts_ms > 200 {
                        flush_scroll_buffer(&state, &mut buffer);
                    }
                }
            }
            thread::sleep(interval);
        }
    })
}

fn pause_recorder() -> Result<()> {
    let base_dir = ensure_app_dir()?;
    let pause_path = base_dir.join(PAUSE_FILE);
    fs::write(pause_path, b"pause")?;
    println!("Pause signal written.");
    Ok(())
}

fn resume_recorder() -> Result<()> {
    let base_dir = ensure_app_dir()?;
    let pause_path = base_dir.join(PAUSE_FILE);
    if pause_path.exists() {
        let _ = fs::remove_file(pause_path);
    }
    println!("Resume signal written.");
    Ok(())
}

fn toggle_pause() -> Result<()> {
    let base_dir = ensure_app_dir()?;
    let pause_path = base_dir.join(PAUSE_FILE);
    if pause_path.exists() {
        let _ = fs::remove_file(pause_path);
        println!("Resume signal written.");
    } else {
        fs::write(pause_path, b"pause")?;
        println!("Pause signal written.");
    }
    Ok(())
}

fn print_status() -> Result<()> {
    let base_dir = ensure_app_dir()?;
    let lock_path = base_dir.join(LOCK_FILE);
    let pause_path = base_dir.join(PAUSE_FILE);
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
        if pause_path.exists() {
            println!("Recorder status: paused");
        } else {
            println!("Recorder status: running");
        }
        if let Some(contents) = info.raw {
            if !contents.trim().is_empty() {
                println!("{contents}");
            }
        }
    } else {
        if pause_path.exists() {
            println!("Recorder status: paused");
        } else {
            println!("Recorder status: running");
        }
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
    config.clipboard_poll_ms = config.clipboard_poll_ms.max(50);
    config.clipboard_debounce_ms = config.clipboard_debounce_ms.max(50);
    config.clipboard_dedupe_window_ms = config.clipboard_dedupe_window_ms.max(0);
    config.window_poll_hz = config.window_poll_hz.max(0);
    config.window_rect_debounce_ms = config.window_rect_debounce_ms.max(0);
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

fn apply_capture_flags(state: &RecorderState, config: &RecorderConfig) {
    state.emit_mouse_move.store(config.emit_mouse_move, Ordering::SeqCst);
    state.emit_mouse_click.store(config.emit_mouse_click, Ordering::SeqCst);
    state.emit_mouse_scroll.store(config.emit_mouse_scroll, Ordering::SeqCst);
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

fn parse_mouse_click_mode(value: &str) -> MouseClickMode {
    match value.to_ascii_lowercase().as_str() {
        "up" => MouseClickMode::Up,
        "both" => MouseClickMode::Both,
        _ => MouseClickMode::Down,
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
            if !state.paused.load(Ordering::SeqCst) {
                flush_text_buffer_if_stale(&state, "idle_timeout");
            }
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
            if state.paused.load(Ordering::SeqCst) {
                thread::sleep(interval);
                continue;
            }
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
            if state.paused.load(Ordering::SeqCst) {
                thread::sleep(interval);
                continue;
            }
            poll_active_window(&state);
            thread::sleep(interval);
        }
    })
}

fn spawn_clipboard_loop(
    state: Arc<RecorderState>,
    shutdown: Arc<AtomicBool>,
    poll_ms: u64,
    debounce_ms: u64,
    base_dir: PathBuf,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let interval = Duration::from_millis(poll_ms.max(50));
        let debounce = Duration::from_millis(debounce_ms.max(50));
        let mut last_seq = unsafe { GetClipboardSequenceNumber() };
        let mut pending_since: Option<Instant> = None;
        while !shutdown.load(Ordering::SeqCst) {
            if state.paused.load(Ordering::SeqCst) {
                thread::sleep(interval);
                continue;
            }
            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq != last_seq {
                last_seq = seq;
                pending_since = Some(Instant::now());
            }
            if let Some(since) = pending_since {
                if since.elapsed() >= debounce {
                    if let Some(event) = read_clipboard_event(&state, &base_dir) {
                        state.sender.try_send(event).ok();
                    }
                    pending_since = None;
                }
            }
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
    pending_rect: Option<PendingRect>,
}

struct PendingRect {
    hwnd: HWND,
    window_info: WindowInfo,
    last_change_ms: i64,
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

fn should_capture_clipboard(state: &RecorderState, window_info: Option<&WindowInfo>) -> bool {
    let process_name = window_info.and_then(|info| info.process_name.as_deref());
    if process_is_blocked(state, process_name) {
        return false;
    }
    if !process_is_allowed(state, process_name) {
        return false;
    }
    true
}

fn read_clipboard_event(state: &RecorderState, base_dir: &Path) -> Option<EventRecord> {
    let window_info = active_window_info().map(|(_, info)| info);
    if !should_capture_clipboard(state, window_info.as_ref()) {
        return None;
    }
    unsafe {
        if OpenClipboard(HWND(0)).is_err() {
            return None;
        }
    }

    let event = read_clipboard_event_locked(state, base_dir, window_info);

    unsafe {
        let _ = CloseClipboard();
    }
    event
}

fn read_clipboard_event_locked(
    state: &RecorderState,
    base_dir: &Path,
    window_info: Option<WindowInfo>,
) -> Option<EventRecord> {
    let image = if unsafe { IsClipboardFormatAvailable(CLIPBOARD_CF_DIBV5).is_ok() } {
        read_clipboard_image(base_dir, CLIPBOARD_CF_DIBV5)
    } else if unsafe { IsClipboardFormatAvailable(CLIPBOARD_CF_DIB).is_ok() } {
        read_clipboard_image(base_dir, CLIPBOARD_CF_DIB)
    } else {
        None
    };
    if let Some((image, hash)) = image {
        if should_skip_clipboard_hash(state, hash) {
            return None;
        }
        return Some(build_clipboard_event(
            state,
            window_info,
            "clipboard_image",
            json!({
                "path": image.path,
                "width": image.width,
                "height": image.height,
            }),
        ));
    }

    if unsafe { IsClipboardFormatAvailable(CLIPBOARD_CF_HDROP).is_ok() } {
        if let Some(files) = read_clipboard_files() {
            return Some(build_clipboard_event(
                state,
                window_info,
                "clipboard_files",
                json!({
                    "files": files,
                }),
            ));
        }
    }

    if unsafe { IsClipboardFormatAvailable(CLIPBOARD_CF_UNICODETEXT).is_ok() } {
        if let Some(text) = read_clipboard_text() {
            let trimmed = truncate_text(text, state.max_text_len);
            return Some(build_clipboard_event(
                state,
                window_info,
                "clipboard_text",
                json!({
                    "text": trimmed.text,
                    "length": trimmed.length,
                    "truncated": trimmed.truncated,
                }),
            ));
        }
    }

    None
}

fn build_clipboard_event(
    state: &RecorderState,
    window_info: Option<WindowInfo>,
    event_type: &str,
    payload: Value,
) -> EventRecord {
    let (process_name, window_title, window_class, window_rect) = match window_info {
        Some(info) => (
            info.process_name.clone(),
            Some(info.title.clone()),
            Some(info.class_name.clone()),
            info.rect.clone(),
        ),
        None => (None, None, None, None),
    };
    EventRecord {
        session_id: state.session_id.clone(),
        ts_wall_ms: now_wall_ms(),
        ts_mono_ms: now_mono_ms(state),
        event_type: event_type.to_string(),
        process_name,
        window_title,
        window_class,
        window_rect,
        mouse: None,
        payload,
    }
}

fn read_clipboard_text() -> Option<String> {
    let handle = unsafe { GetClipboardData(CLIPBOARD_CF_UNICODETEXT) }.ok()?;
    let hglobal = HGLOBAL(handle.0 as *mut c_void);
    let size = unsafe { GlobalSize(hglobal) };
    if size == 0 {
        return None;
    }
    let ptr = unsafe { GlobalLock(hglobal) } as *const u16;
    if ptr.is_null() {
        return None;
    }
    let max_len = size / 2;
    let mut len = 0usize;
    unsafe {
        while len < max_len {
            if *ptr.add(len) == 0 {
                break;
            }
            len += 1;
        }
    }
    let slice = unsafe { std::slice::from_raw_parts(ptr, len) };
    let text = String::from_utf16_lossy(slice);
    let _ = unsafe { GlobalUnlock(hglobal) };
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn read_clipboard_files() -> Option<Vec<String>> {
    let handle = unsafe { GetClipboardData(CLIPBOARD_CF_HDROP) }.ok()?;
    let hdrop = HDROP(handle.0);
    let count = unsafe { DragQueryFileW(hdrop, 0xFFFFFFFF, None) };
    if count == 0 {
        return None;
    }
    let mut files = Vec::new();
    for index in 0..count {
        let length = unsafe { DragQueryFileW(hdrop, index, None) };
        if length == 0 {
            continue;
        }
        let mut buffer = vec![0u16; length as usize + 1];
        let written = unsafe { DragQueryFileW(hdrop, index, Some(buffer.as_mut_slice())) };
        if written == 0 {
            continue;
        }
        let path = String::from_utf16_lossy(&buffer[..written as usize]);
        files.push(path);
    }
    if files.is_empty() {
        None
    } else {
        Some(files)
    }
}

fn should_skip_clipboard_hash(state: &RecorderState, hash: u64) -> bool {
    let now_ms = now_mono_ms(state);
    let mut last = state.last_clipboard_hash.lock().unwrap();
    if let Some(last_hash) = last.as_ref() {
        if last_hash.hash == hash && now_ms - last_hash.ts_ms <= state.clipboard_dedupe_window_ms {
            return true;
        }
    }
    *last = Some(ClipboardHash {
        hash,
        ts_ms: now_ms,
    });
    false
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn read_clipboard_image(base_dir: &Path, format: u32) -> Option<(ClipboardImage, u64)> {
    let handle = unsafe { GetClipboardData(format) }.ok()?;
    let hglobal = HGLOBAL(handle.0 as *mut c_void);
    let size = unsafe { GlobalSize(hglobal) };
    if size < 40 {
        return None;
    }
    let ptr = unsafe { GlobalLock(hglobal) } as *const u8;
    if ptr.is_null() {
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, size) }.to_vec();
    let _ = unsafe { GlobalUnlock(hglobal) };

    let info = parse_dib_info(&bytes)?;
    let path = write_clipboard_image(base_dir, &bytes, info.image_size)?;
    let hash = hash_bytes(&bytes);
    Some((
        ClipboardImage {
            path,
            width: info.width,
            height: info.height,
        },
        hash,
    ))
}

struct DibInfo {
    width: i32,
    height: i32,
    image_size: usize,
}

fn parse_dib_info(bytes: &[u8]) -> Option<DibInfo> {
    if bytes.len() < 40 {
        return None;
    }
    let header_size = u32::from_le_bytes(bytes.get(0..4)?.try_into().ok()?);
    if header_size < 40 || bytes.len() < header_size as usize {
        return None;
    }
    let width = i32::from_le_bytes(bytes.get(4..8)?.try_into().ok()?);
    let height = i32::from_le_bytes(bytes.get(8..12)?.try_into().ok()?);
    let bit_count = u16::from_le_bytes(bytes.get(14..16)?.try_into().ok()?);
    let size_image = u32::from_le_bytes(bytes.get(20..24)?.try_into().ok()?);

    let width_abs = width.abs().max(1) as u32;
    let height_abs = height.abs().max(1) as u32;
    let row_bytes = ((bit_count as u32 * width_abs + 31) / 32) * 4;
    let computed_image = row_bytes.saturating_mul(height_abs) as usize;

    let mut image_size = if size_image > 0 {
        size_image as usize
    } else {
        computed_image
    };
    if image_size == 0 || image_size > bytes.len() {
        image_size = bytes.len().min(computed_image);
    }
    Some(DibInfo {
        width,
        height: height.abs(),
        image_size,
    })
}

fn write_clipboard_image(base_dir: &Path, dib_bytes: &[u8], image_size: usize) -> Option<String> {
    let dir = base_dir.join(CLIPBOARD_DIR);
    if fs::create_dir_all(&dir).is_err() {
        return None;
    }
    let file_name = format!("clipboard_{}_{}.bmp", now_wall_ms(), Uuid::new_v4());
    let path = dir.join(file_name);

    let header_bytes = dib_bytes.len().saturating_sub(image_size);
    let offset = 14u32.saturating_add(header_bytes as u32);
    let file_size = 14u32.saturating_add(dib_bytes.len() as u32);

    let mut file = fs::File::create(&path).ok()?;
    file.write_all(b"BM").ok()?;
    file.write_all(&file_size.to_le_bytes()).ok()?;
    file.write_all(&[0u8; 4]).ok()?;
    file.write_all(&offset.to_le_bytes()).ok()?;
    file.write_all(dib_bytes).ok()?;

    Some(path.to_string_lossy().to_string())
}

struct TruncateResult {
    text: String,
    length: usize,
    truncated: bool,
}

fn truncate_text(text: String, max_len: usize) -> TruncateResult {
    let length = text.chars().count();
    if length <= max_len {
        return TruncateResult {
            text,
            length,
            truncated: false,
        };
    }
    let truncated = text.chars().take(max_len).collect::<String>();
    TruncateResult {
        text: truncated,
        length,
        truncated: true,
    }
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
    if state.paused.load(Ordering::SeqCst) {
        return;
    }
    let now_ms = now_mono_ms(state);
    let (is_new, rect_changed) = {
        let mut tracker = state.window_tracker.lock().unwrap();
        let is_new = hwnd != tracker.last_hwnd;
        let rect_changed = is_new || window_info.rect != tracker.last_rect;
        tracker.last_hwnd = hwnd;
        tracker.last_rect = window_info.rect.clone();
        if is_new {
            tracker.pending_rect = None;
        }
        (is_new, rect_changed)
    };

    if is_new {
        flush_text_buffer_with_window(state, Some(window_info.clone()), "window_change");
        send_active_window_changed(state, &window_info);
    }
    if rect_changed && !is_new {
        if state.window_rect_debounce_ms <= 0 {
            send_window_rect_changed(state, &window_info);
            return;
        }
        let mut tracker = state.window_tracker.lock().unwrap();
        tracker.pending_rect = Some(PendingRect {
            hwnd,
            window_info,
            last_change_ms: now_ms,
        });
        return;
    }
}

fn spawn_window_rect_flush_loop(state: Arc<RecorderState>, shutdown: Arc<AtomicBool>) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let interval = Duration::from_millis(100);
        while !shutdown.load(Ordering::SeqCst) {
            if state.paused.load(Ordering::SeqCst) {
                thread::sleep(interval);
                continue;
            }
            let pending = {
                let mut tracker = state.window_tracker.lock().unwrap();
                let last_hwnd = tracker.last_hwnd;
                if let Some(pending) = tracker.pending_rect.as_mut() {
                    let now_ms = now_mono_ms(state.as_ref());
                    if now_ms - pending.last_change_ms < state.window_rect_debounce_ms {
                        None
                    } else if last_hwnd.0 != pending.hwnd.0 {
                        tracker.pending_rect = None;
                        None
                    } else {
                        let info = pending.window_info.clone();
                        tracker.pending_rect = None;
                        Some(info)
                    }
                } else {
                    None
                }
            };
            if let Some(info) = pending {
                send_window_rect_changed(&state, &info);
            }
            thread::sleep(interval);
        }
    })
}

fn send_active_window_changed(state: &RecorderState, window_info: &WindowInfo) {
    let icon_path = window_info
        .process_name
        .as_deref()
        .and_then(|path| ensure_app_icon(state, path));
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
        payload: json!({ "app_icon_path": icon_path }),
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

fn buffer_mouse_scroll(state: &RecorderState, mono_ms: i64, data: &MSLLHOOKSTRUCT, delta: Option<i32>) {
    let delta_value = delta.unwrap_or(0);
    let mut buffer = state.scroll_buffer.lock().unwrap();
    if let Some(existing) = buffer.as_mut() {
        if mono_ms - existing.last_ts_ms <= 200 {
            existing.last_ts_ms = mono_ms;
            existing.total_delta += delta_value;
            existing.ticks += 1;
            existing.x = data.pt.x;
            existing.y = data.pt.y;
            return;
        }
        flush_scroll_buffer(state, &mut buffer);
    }
    *buffer = Some(ScrollBuffer {
        last_ts_ms: mono_ms,
        x: data.pt.x,
        y: data.pt.y,
        total_delta: delta_value,
        ticks: 1,
    });
}

fn flush_scroll_buffer(state: &RecorderState, buffer: &mut Option<ScrollBuffer>) {
    let Some(existing) = buffer.take() else {
        return;
    };
    let mouse = MouseInfo {
        x: existing.x,
        y: existing.y,
        button: None,
        delta: Some(existing.total_delta),
    };
    let event = EventRecord {
        session_id: state.session_id.clone(),
        ts_wall_ms: now_wall_ms(),
        ts_mono_ms: existing.last_ts_ms,
        event_type: "mouse_scroll".to_string(),
        process_name: None,
        window_title: None,
        window_class: None,
        window_rect: None,
        mouse: Some(mouse),
        payload: json!({ "ticks": existing.ticks, "total_delta": existing.total_delta }),
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
    if state.paused.load(Ordering::SeqCst) {
        return;
    }
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
            if state.paused.load(Ordering::SeqCst) {
                return CallNextHookEx(None, code, wparam, lparam);
            }
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
                if event_type == "mouse_move" && !state.emit_mouse_move.load(Ordering::SeqCst) {
                    return CallNextHookEx(HHOOK(0), code, wparam, lparam);
                }
                if event_type == "mouse_click" && !state.emit_mouse_click.load(Ordering::SeqCst) {
                    return CallNextHookEx(HHOOK(0), code, wparam, lparam);
                }
                if event_type == "mouse_click" {
                    let is_down = matches!(
                        wparam.0 as u32,
                        WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN
                    );
                    let is_up = matches!(
                        wparam.0 as u32,
                        WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP
                    );
                    let allow = match state.mouse_click_mode {
                        MouseClickMode::Down => is_down,
                        MouseClickMode::Up => is_up,
                        MouseClickMode::Both => is_down || is_up,
                    };
                    if !allow {
                        return CallNextHookEx(HHOOK(0), code, wparam, lparam);
                    }
                }
                if event_type == "mouse_scroll" && !state.emit_mouse_scroll.load(Ordering::SeqCst) {
                    return CallNextHookEx(HHOOK(0), code, wparam, lparam);
                }
                let mono_ms = now_mono_ms(state);
                if event_type == "mouse_scroll" {
                    buffer_mouse_scroll(state, mono_ms, &data, delta);
                    return CallNextHookEx(HHOOK(0), code, wparam, lparam);
                }
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
            if state.paused.load(Ordering::SeqCst) {
                return CallNextHookEx(None, code, wparam, lparam);
            }
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
                let is_repeat = is_down && was_pressed;
                let is_injected = (data.flags & KBDLLHOOKSTRUCT_FLAGS(0x10)) != KBDLLHOOKSTRUCT_FLAGS(0);

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
                            "repeat": is_repeat,
                            "injected": is_injected,
                            "scan_code": data.scanCode,
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
                            "repeat": is_repeat,
                            "injected": is_injected,
                            "scan_code": data.scanCode,
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

fn snapshot_text_from_uia(_state: &RecorderState) -> Option<String> {
    let Some(uia) = get_uia() else {
        return None;
    };
    let element = match unsafe { uia.GetFocusedElement() } {
        Ok(element) => element,
        Err(_) => return None,
    };
    let has_focus = unsafe { element.CurrentHasKeyboardFocus() }
        .ok()
        .map(|value| value.as_bool())
        .unwrap_or(false);
    if !has_focus {
        return None;
    }
    let is_password = unsafe { element.CurrentIsPassword() }
        .ok()
        .map(|value| value.as_bool())
        .unwrap_or(false);
    if is_password {
        return None;
    }
    let control_type = unsafe { element.CurrentControlType() }.unwrap_or(UIA_CONTROLTYPE_ID(0));
    if control_type != UIA_EditControlTypeId && control_type != UIA_DocumentControlTypeId {
        return None;
    }
    let pattern: IUIAutomationValuePattern =
        unsafe { element.GetCurrentPatternAs(UIA_ValuePatternId) }.ok()?;
    let value = unsafe { pattern.CurrentValue() }.ok()?;
    let text = String::from_utf16_lossy(value.as_wide());
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
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

fn hash_process_name(process_name: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    process_name.hash(&mut hasher);
    hasher.finish()
}

fn ensure_app_icon(state: &RecorderState, process_path: &str) -> Option<String> {
    if process_path.is_empty() {
        return None;
    }
    {
        let cache = state.app_icon_cache.lock().unwrap();
        if let Some(path) = cache.get(process_path) {
            return Some(path.clone());
        }
    }

    let hash = hash_process_name(process_path);
    let icon_path = state.icons_dir.join(format!("{hash}.bmp"));
    if icon_path.exists() {
        let mut cache = state.app_icon_cache.lock().unwrap();
        let path_string = icon_path.to_string_lossy().to_string();
        cache.insert(process_path.to_string(), path_string.clone());
        return Some(path_string);
    }

    if capture_icon_bmp(process_path, &icon_path).is_ok() {
        let mut cache = state.app_icon_cache.lock().unwrap();
        let path_string = icon_path.to_string_lossy().to_string();
        cache.insert(process_path.to_string(), path_string.clone());
        return Some(path_string);
    }

    None
}

fn capture_icon_bmp(process_path: &str, icon_path: &Path) -> Result<()> {
    let mut wide: Vec<u16> = process_path.encode_utf16().collect();
    wide.push(0);
    let mut info = SHFILEINFOW::default();
    let result = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if result == 0 {
        anyhow::bail!("SHGetFileInfoW failed");
    }

    let hicon = info.hIcon;
    if hicon.0 == 0 {
        anyhow::bail!("No icon handle");
    }

    let mut icon_info = ICONINFO::default();
    unsafe {
        if GetIconInfo(hicon, &mut icon_info).is_err() {
            let _ = DestroyIcon(hicon);
            anyhow::bail!("GetIconInfo failed");
        }
    }

    let color_bitmap = if icon_info.hbmColor.0 != 0 {
        icon_info.hbmColor
    } else {
        icon_info.hbmMask
    };

    let mut bitmap = BITMAP::default();
    unsafe {
        GetObjectW(color_bitmap, std::mem::size_of::<BITMAP>() as i32, Some(&mut bitmap as *mut _ as *mut c_void));
    }

    let width = bitmap.bmWidth;
    let height = bitmap.bmHeight;
    if width <= 0 || height <= 0 {
        unsafe {
            DeleteObject(icon_info.hbmColor);
            DeleteObject(icon_info.hbmMask);
            let _ = DestroyIcon(hicon);
        }
        anyhow::bail!("Invalid bitmap size");
    }

    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: height,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        biSizeImage: (width * height * 4) as u32,
        ..Default::default()
    };

    let data_len = (width * height * 4) as usize;
    let mut buffer = vec![0u8; data_len];
    let hdc = unsafe { CreateCompatibleDC(None) };
    let old_obj = unsafe { SelectObject(hdc, color_bitmap) };
    let scanlines = unsafe {
        GetDIBits(
            hdc,
            color_bitmap,
            0,
            height as u32,
            Some(buffer.as_mut_ptr() as *mut c_void),
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };
    unsafe {
        SelectObject(hdc, old_obj);
        DeleteDC(hdc);
        DeleteObject(icon_info.hbmColor);
        DeleteObject(icon_info.hbmMask);
        let _ = DestroyIcon(hicon);
    }
    if scanlines == 0 {
        anyhow::bail!("GetDIBits failed");
    }

    let file_header_size = 14u32;
    let info_header_size = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    let file_size = file_header_size + info_header_size + data_len as u32;

    let mut file = fs::File::create(icon_path).context("Failed to create icon file")?;
    file.write_all(&[
        0x42, 0x4d,
        (file_size & 0xFF) as u8,
        ((file_size >> 8) & 0xFF) as u8,
        ((file_size >> 16) & 0xFF) as u8,
        ((file_size >> 24) & 0xFF) as u8,
        0, 0, 0, 0,
        (file_header_size + info_header_size) as u8,
        0, 0, 0,
    ])?;

    file.write_all(&bmi.bmiHeader.biSize.to_le_bytes())?;
    file.write_all(&bmi.bmiHeader.biWidth.to_le_bytes())?;
    file.write_all(&bmi.bmiHeader.biHeight.to_le_bytes())?;
    file.write_all(&bmi.bmiHeader.biPlanes.to_le_bytes())?;
    file.write_all(&bmi.bmiHeader.biBitCount.to_le_bytes())?;
    file.write_all(&bmi.bmiHeader.biCompression.to_le_bytes())?;
    file.write_all(&bmi.bmiHeader.biSizeImage.to_le_bytes())?;
    file.write_all(&bmi.bmiHeader.biXPelsPerMeter.to_le_bytes())?;
    file.write_all(&bmi.bmiHeader.biYPelsPerMeter.to_le_bytes())?;
    file.write_all(&bmi.bmiHeader.biClrUsed.to_le_bytes())?;
    file.write_all(&bmi.bmiHeader.biClrImportant.to_le_bytes())?;
    file.write_all(&buffer)?;
    Ok(())
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
    let final_text = if state.text_snapshot_on_idle
        && matches!(reason, "idle_timeout" | "timeout")
        && should_capture_text(state, window_info.as_ref())
    {
        snapshot_text_from_uia(state)
    } else {
        None
    };
    send_text_event(state, window_info, text, reason, final_text);
}

fn send_text_event(
    state: &RecorderState,
    window_info: Option<WindowInfo>,
    text: String,
    reason: &str,
    final_text: Option<String>,
) {
    let (process_name, window_title, window_class, window_rect) = match window_info {
        Some(info) => (
            info.process_name.clone(),
            Some(info.title.clone()),
            Some(info.class_name.clone()),
            info.rect.clone(),
        ),
        None => (None, None, None, None),
    };
    let final_text = final_text.map(|text| truncate_text(text, state.max_text_len));
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
            "final_text": final_text.as_ref().map(|value| value.text.clone()),
            "final_text_length": final_text.as_ref().map(|value| value.length),
            "final_text_truncated": final_text.as_ref().map(|value| value.truncated),
            "source": if final_text.is_some() { "uia" } else { "buffer" },
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
