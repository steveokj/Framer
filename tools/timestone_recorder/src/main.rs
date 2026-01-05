use anyhow::{Context, Result};
use chrono::{DateTime, Local};
use crossbeam_channel::{bounded, Receiver, Sender};
use once_cell::sync::OnceCell;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use windows::Win32::Foundation::{CloseHandle, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::ProcessStatus::QueryFullProcessImageNameW;
use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    CallNextHookEx, SetWindowsHookExW, KBDLLHOOKSTRUCT, MSLLHOOKSTRUCT, VK_CONTROL, VK_LCONTROL, VK_LMENU, VK_LSHIFT,
    VK_LWIN, VK_MENU, VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT, WH_KEYBOARD_LL, WH_MOUSE_LL,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetClassNameW, GetForegroundWindow, GetMessageW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
    PostQuitMessage, TranslateMessage, UnhookWindowsHookEx, HHOOK, MSG, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_RBUTTONDOWN, WM_RBUTTONUP, WM_SYSKEYDOWN,
    WM_SYSKEYUP,
};

const APP_DIR: &str = "data\\timestone";
const DB_NAME: &str = "timestone_events.sqlite3";
const LOCK_FILE: &str = "recorder.lock";
const STOP_FILE: &str = "stop.signal";

static STATE: OnceCell<Arc<RecorderState>> = OnceCell::new();

#[derive(Clone)]
struct RecorderConfig {
    mouse_hz: u64,
    snapshot_hz: u64,
    capture_raw_keys: bool,
    obs_video_path: Option<String>,
}

#[derive(Clone)]
struct SessionInfo {
    session_id: String,
    start_wall_ms: i64,
    start_wall_iso: String,
    obs_video_path: Option<String>,
}

struct RecorderState {
    session_id: String,
    sender: Sender<EventRecord>,
    start_instant: Instant,
    shutdown: Arc<AtomicBool>,
    mouse_move_interval_ms: i64,
    last_mouse_move_ms: AtomicI64,
    capture_raw_keys: bool,
    pressed_keys: Mutex<HashSet<u32>>,
}

#[derive(Serialize, Clone)]
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
            let config = parse_start_args(args);
            run_recorder(config)?;
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
    println!("  timestone_recorder start [--raw-keys] [--mouse-hz N] [--snapshot-hz N] [--obs-video PATH]");
    println!("  timestone_recorder stop");
    println!("  timestone_recorder status");
}

fn parse_start_args(mut args: impl Iterator<Item = String>) -> RecorderConfig {
    let mut config = RecorderConfig {
        mouse_hz: 30,
        snapshot_hz: 1,
        capture_raw_keys: false,
        obs_video_path: None,
    };
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--raw-keys" => {
                config.capture_raw_keys = true;
            }
            "--mouse-hz" => {
                if let Some(value) = args.next() {
                    if let Ok(parsed) = value.parse::<u64>() {
                        config.mouse_hz = parsed.max(1);
                    }
                }
            }
            "--snapshot-hz" => {
                if let Some(value) = args.next() {
                    if let Ok(parsed) = value.parse::<u64>() {
                        config.snapshot_hz = parsed.max(1);
                    }
                }
            }
            "--obs-video" => {
                if let Some(value) = args.next() {
                    config.obs_video_path = Some(value);
                }
            }
            _ => {}
        }
    }
    config
}

fn run_recorder(config: RecorderConfig) -> Result<()> {
    let base_dir = ensure_app_dir()?;
    let lock_path = base_dir.join(LOCK_FILE);
    if lock_path.exists() {
        println!("Recorder already running (lock file present).");
        return Ok(());
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
        shutdown: shutdown.clone(),
        mouse_move_interval_ms: (1000 / config.mouse_hz.max(1)) as i64,
        last_mouse_move_ms: AtomicI64::new(-1),
        capture_raw_keys: config.capture_raw_keys,
        pressed_keys: Mutex::new(HashSet::new()),
    });
    let _ = STATE.set(state.clone());

    let db_path = base_dir.join(DB_NAME);
    let writer_shutdown = shutdown.clone();
    let writer_handle = thread::spawn(move || run_writer(rx, &db_path, session, writer_shutdown));

    ctrlc::set_handler({
        let shutdown = shutdown.clone();
        move || {
            shutdown.store(true, Ordering::SeqCst);
            unsafe {
                PostQuitMessage(0);
            }
        }
    })
    .context("Failed to set Ctrl+C handler")?;

    send_session_event(&state, "session_start", json!({ "note": "manual_start" }));

    let stop_signal_path = base_dir.join(STOP_FILE);
    let snapshot_handle = spawn_snapshot_loop(state.clone(), stop_signal_path, shutdown.clone(), config.snapshot_hz);

    let (mouse_hook, keyboard_hook) = install_hooks()?;

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

    shutdown.store(true, Ordering::SeqCst);
    send_session_event(&state, "session_stop", json!({ "note": "manual_stop" }));
    unsafe {
        UnhookWindowsHookEx(mouse_hook);
        UnhookWindowsHookEx(keyboard_hook);
    }

    snapshot_handle.join().ok();
    writer_handle.join().ok();
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
    Ok(())
}

fn print_status() -> Result<()> {
    let base_dir = ensure_app_dir()?;
    let lock_path = base_dir.join(LOCK_FILE);
    if !lock_path.exists() {
        println!("Recorder status: stopped");
        return Ok(());
    }
    let contents = fs::read_to_string(lock_path).unwrap_or_default();
    println!("Recorder status: running");
    if !contents.trim().is_empty() {
        println!("{contents}");
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

fn spawn_snapshot_loop(
    state: Arc<RecorderState>,
    stop_path: PathBuf,
    shutdown: Arc<AtomicBool>,
    snapshot_hz: u64,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut last_hwnd = HWND(0);
        let mut last_rect: Option<RectInfo> = None;
        let interval = Duration::from_millis(1000 / snapshot_hz.max(1));
        while !shutdown.load(Ordering::SeqCst) {
            if stop_path.exists() {
                let _ = fs::remove_file(&stop_path);
                shutdown.store(true, Ordering::SeqCst);
                unsafe {
                    PostQuitMessage(0);
                }
                break;
            }

            if let Some(snapshot) = build_snapshot(&state) {
                state.sender.try_send(snapshot).ok();
            }

            if let Some((hwnd, window_info)) = active_window_info() {
                if hwnd != last_hwnd {
                    last_hwnd = hwnd;
                    let event = EventRecord {
                        session_id: state.session_id.clone(),
                        ts_wall_ms: now_wall_ms(),
                        ts_mono_ms: now_mono_ms(&state),
                        event_type: "active_window_changed".to_string(),
                        process_name: window_info.process_name.clone(),
                        window_title: window_info.title.clone(),
                        window_class: window_info.class_name.clone(),
                        window_rect: window_info.rect.clone(),
                        mouse: None,
                        payload: json!({}),
                    };
                    state.sender.try_send(event).ok();
                }

                if window_info.rect != last_rect {
                    last_rect = window_info.rect.clone();
                    let event = EventRecord {
                        session_id: state.session_id.clone(),
                        ts_wall_ms: now_wall_ms(),
                        ts_mono_ms: now_mono_ms(&state),
                        event_type: "window_rect_changed".to_string(),
                        process_name: window_info.process_name.clone(),
                        window_title: window_info.title.clone(),
                        window_class: window_info.class_name.clone(),
                        window_rect: window_info.rect.clone(),
                        mouse: None,
                        payload: json!({}),
                    };
                    state.sender.try_send(event).ok();
                }
            }

            thread::sleep(interval);
        }
    })
}

fn install_hooks() -> Result<(HHOOK, HHOOK)> {
    unsafe {
        let module = GetModuleHandleW(None).unwrap_or(HINSTANCE::default());
        let mouse_hook = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), module, 0);
        if mouse_hook.0 == 0 {
            anyhow::bail!("Failed to install mouse hook");
        }
        let keyboard_hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook_proc), module, 0);
        if keyboard_hook.0 == 0 {
            UnhookWindowsHookEx(mouse_hook);
            anyhow::bail!("Failed to install keyboard hook");
        }
        Ok((mouse_hook, keyboard_hook))
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

fn cursor_position() -> Option<(i32, i32)> {
    unsafe {
        let mut pt = POINT::default();
        if windows::Win32::UI::WindowsAndMessaging::GetCursorPos(&mut pt).as_bool() {
            Some((pt.x, pt.y))
        } else {
            None
        }
    }
}

fn active_window_info() -> Option<(HWND, WindowInfo)> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0 == 0 {
            return None;
        }
        let title = get_window_text(hwnd);
        let class_name = get_window_class(hwnd);
        let rect = get_window_rect(hwnd);
        let process_name = get_process_name(hwnd);
        Some((
            hwnd,
            WindowInfo {
                title,
                class_name,
                rect,
                process_name,
            },
        ))
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
        if GetWindowRect(hwnd, &mut rect).as_bool() {
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
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if handle.is_invalid() {
            return None;
        }
        let mut buffer = vec![0u16; 512];
        let mut size: u32 = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, &mut buffer, &mut size).as_bool();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
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
                if is_down {
                    pressed.insert(vk);
                } else {
                    pressed.remove(&vk);
                }

                let modifiers = current_modifiers(&pressed);
                let is_modifier = is_modifier_key(vk);
                if is_down && !is_modifier && !modifiers.is_empty() {
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

                if state.capture_raw_keys {
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

fn run_writer(rx: Receiver<EventRecord>, db_path: &Path, session: SessionInfo, shutdown: Arc<AtomicBool>) {
    let conn = match Connection::open(db_path) {
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
                    if let Err(err) = flush_events(&conn, &buffer) {
                        eprintln!("Event flush failed: {err}");
                    }
                    buffer.clear();
                }
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                if !buffer.is_empty() {
                    if let Err(err) = flush_events(&conn, &buffer) {
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

fn flush_events(conn: &Connection, events: &[EventRecord]) -> Result<()> {
    let tx = conn.transaction()?;
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
    tx.commit()?;
    Ok(())
}
