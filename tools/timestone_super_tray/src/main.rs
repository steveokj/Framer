use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use rusqlite::{params, Connection};
use std::collections::hash_map::DefaultHasher;
use std::env;
use std::fs::{self, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, POINT, STILL_ACTIVE, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, CREATE_NO_WINDOW, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{
    Shell_NotifyIconW, NOTIFYICONDATAW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_NOREPEAT, MOD_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos,
    GetMessageW, LoadIconW, LoadImageW, MessageBoxW, PostQuitMessage, RegisterClassW, SetForegroundWindow, SetTimer,
    TrackPopupMenu, TranslateMessage, CW_USEDEFAULT, HICON, HMENU, IMAGE_ICON, IDYES, LR_DEFAULTSIZE, LR_LOADFROMFILE,
    MB_OK, MB_YESNO, MF_CHECKED, MF_GRAYED, MF_POPUP, MF_SEPARATOR, MF_STRING, TPM_LEFTALIGN, TPM_TOPALIGN, WM_COMMAND,
    WM_DESTROY, WM_HOTKEY,
    WM_LBUTTONUP, WM_RBUTTONUP, WM_NULL, WM_TIMER, WM_USER, WNDCLASSW, WS_OVERLAPPEDWINDOW,
};

const APP_DIR: &str = "data\\timestone";
const TRAY_CONFIG_FILE: &str = "super_tray_config.json";
const TRAY_ICON_CACHE: &str = "tray_icons";
const LOG_DIR: &str = "logs";
const TRAY_LOG_FILE: &str = "super_tray.log";

const TRAY_ICON_ID: u32 = 1;
const WM_TRAY: u32 = WM_USER + 1;
const TIMER_ID: usize = 1;
const TIMER_MS: u32 = 5000;
const DEFAULT_OBS_HOST: &str = "192.168.2.34";
const DEFAULT_OBS_PORT: u16 = 4455;

const CMD_START: u16 = 1001;
const CMD_PAUSE: u16 = 1002;
const CMD_RESUME: u16 = 1003;
const CMD_STOP: u16 = 1004;
const CMD_STATUS: u16 = 1005;
const CMD_EXIT: u16 = 1006;
const CMD_MODE_FULL: u16 = 2001;
const CMD_MODE_MID: u16 = 2002;
const CMD_MODE_LOW: u16 = 2003;

const HOTKEY_F13: i32 = 1;
const HOTKEY_SHIFT_F13: i32 = 2;
const HOTKEY_ALT_F13: i32 = 3;
const HOTKEY_F14: i32 = 4;
const HOTKEY_SHIFT_F14: i32 = 5;
const HOTKEY_ALT_F14: i32 = 6;

const VK_F13: u32 = 0x7C;
const VK_F14: u32 = 0x7D;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Full,
    Mid,
    Low,
}

impl Default for Mode {
    fn default() -> Self {
        Mode::Full
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct TrayConfig {
    icon_running: Option<String>,
    icon_paused: Option<String>,
    icon_stopped: Option<String>,
    icon_running_full: Option<String>,
    icon_running_mid: Option<String>,
    icon_running_low: Option<String>,
    icon_paused_full: Option<String>,
    icon_paused_mid: Option<String>,
    icon_paused_low: Option<String>,
    tooltip: Option<String>,
    recorder_exe: Option<String>,
    recorder_args: Option<Vec<String>>,
    obs_ws_exe: Option<String>,
    file_tapper_exe: Option<String>,
    obs_host: Option<String>,
    obs_port: Option<u16>,
    obs_password: Option<String>,
    last_mode: Mode,
    file_tapper_event_types: Option<Vec<String>>,
    file_tapper_ocr_keydown_mode: Option<String>,
    file_tapper_frame_offset_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecorderStatus {
    Running,
    Paused,
    Stopped,
}

#[derive(Clone, Copy)]
enum TrayAction {
    Start,
    StartInMode(Mode),
    Stop,
    Pause,
    Resume,
    SetMode(Mode),
    Exit,
}

#[derive(Clone)]
struct RecorderCommand {
    exe: String,
    args_prefix: Vec<String>,
}

struct AppState {
    hwnd: HWND,
    tooltip: String,
    command: RecorderCommand,
    data_dir: PathBuf,
    icon_stopped: HICON,
    icon_running_full: HICON,
    icon_running_mid: HICON,
    icon_running_low: HICON,
    icon_paused_full: HICON,
    icon_paused_mid: HICON,
    icon_paused_low: HICON,
    status: RecorderStatus,
    busy: bool,
    mode: Mode,
    obs_host: String,
    obs_port: u16,
    obs_password: Option<String>,
    obs_ws_exe: String,
    file_tapper_exe: String,
    db_path: PathBuf,
    obs_ws_child: Option<Child>,
    file_tapper_child: Option<Child>,
    obs_started: bool,
    file_tapper_event_types: Option<Vec<String>>,
    file_tapper_ocr_keydown_mode: Option<String>,
    file_tapper_frame_offset_ms: Option<i64>,
}

static STATE: OnceLock<Arc<Mutex<AppState>>> = OnceLock::new();

fn file_logging_enabled() -> bool {
    match env::var("TIMESTONE_FILE_LOGS") {
        Ok(value) => {
            let value = value.trim().to_lowercase();
            !(value == "0" || value == "false" || value == "off")
        }
        Err(_) => true,
    }
}

fn log_line(data_dir: &Path, message: &str) {
    if !file_logging_enabled() {
        return;
    }
    let log_dir = data_dir.join(LOG_DIR);
    let path = log_dir.join(TRAY_LOG_FILE);
    let _ = fs::create_dir_all(&log_dir);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[{}] {}", ts, message);
    }
}

fn main() -> Result<()> {
    let base_dir = ensure_app_dir()?;
    let config = load_or_create_config(&base_dir)?;
    let command = build_command(&config);
    let obs_ws_exe = config
        .obs_ws_exe
        .clone()
        .or_else(find_default_obs_ws_exe)
        .unwrap_or_else(|| "timestone_obs_ws.exe".to_string());
    let file_tapper_exe = config
        .file_tapper_exe
        .clone()
        .or_else(find_default_file_tapper_exe)
        .unwrap_or_else(|| "timestone_file_tapper.exe".to_string());
    let obs_host = config
        .obs_host
        .clone()
        .unwrap_or_else(|| DEFAULT_OBS_HOST.to_string());
    let obs_port = config.obs_port.unwrap_or(DEFAULT_OBS_PORT);
    let obs_password = config.obs_password.clone().or_else(|| env::var("OBS_WS_PASSWORD").ok());
    let mode = config.last_mode;
    let file_tapper_event_types = config.file_tapper_event_types.clone();
    let file_tapper_ocr_keydown_mode = config.file_tapper_ocr_keydown_mode.clone();
    let file_tapper_frame_offset_ms = config.file_tapper_frame_offset_ms;
    let data_dir = base_dir.clone();
    let tooltip = config
        .tooltip
        .clone()
        .unwrap_or_else(|| "Timestone Supervisor".to_string());

    let icon_running = load_icon(&base_dir, config.icon_running.as_deref())?;
    let icon_paused = load_icon(&base_dir, config.icon_paused.as_deref())?;
    let icon_stopped = load_icon(&base_dir, config.icon_stopped.as_deref())?;
    let icon_running_full = load_icon_with_fallback(
        &base_dir,
        config.icon_running_full.as_deref(),
        icon_running,
    )?;
    let icon_running_mid = load_icon_with_fallback(
        &base_dir,
        config.icon_running_mid.as_deref(),
        icon_running,
    )?;
    let icon_running_low = load_icon_with_fallback(
        &base_dir,
        config.icon_running_low.as_deref(),
        icon_running,
    )?;
    let icon_paused_full = load_icon_with_fallback(
        &base_dir,
        config.icon_paused_full.as_deref(),
        icon_paused,
    )?;
    let icon_paused_mid = load_icon_with_fallback(
        &base_dir,
        config.icon_paused_mid.as_deref(),
        icon_paused,
    )?;
    let icon_paused_low = load_icon_with_fallback(
        &base_dir,
        config.icon_paused_low.as_deref(),
        icon_paused,
    )?;
    let db_path = data_dir.join("timestone_events.sqlite3");

    unsafe {
        let class_name = to_wide("TimestoneTrayWindow");
        let hinstance = GetModuleHandleW(None)?;
        let wc = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: hinstance.into(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            ..Default::default()
        };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(
            Default::default(),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(class_name.as_ptr()),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            HWND(0),
            HMENU(0),
            hinstance,
            None,
        );
        let status = get_status(&command).unwrap_or(RecorderStatus::Stopped);
        let state = AppState {
            hwnd,
            tooltip,
            command,
            data_dir,
            icon_stopped,
            icon_running_full,
            icon_running_mid,
            icon_running_low,
            icon_paused_full,
            icon_paused_mid,
            icon_paused_low,
            status,
            busy: false,
            mode,
            obs_host,
            obs_port,
            obs_password,
            obs_ws_exe,
            file_tapper_exe,
            db_path,
            obs_ws_child: None,
            file_tapper_child: None,
            obs_started: false,
            file_tapper_event_types,
            file_tapper_ocr_keydown_mode,
            file_tapper_frame_offset_ms,
        };
        let shared = Arc::new(Mutex::new(state));
        let _ = STATE.set(shared);
        log_line(&base_dir, &format!("Tray started. status={status:?}"));
        register_hotkeys(hwnd);
        update_tray_icon()?;
        let _ = SetTimer(hwnd, TIMER_ID, TIMER_MS, None);
        if status == RecorderStatus::Stopped {
            dispatch_action(TrayAction::Start, false, false);
        } else {
            dispatch_action(TrayAction::Stop, false, false);
        }

        let mut msg = std::mem::zeroed();
        while GetMessageW(&mut msg, HWND(0), 0, 0).into() {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        unregister_hotkeys(hwnd);
        cleanup_tray_icon();
        let _ = DestroyWindow(hwnd);
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

fn load_or_create_config(base_dir: &Path) -> Result<TrayConfig> {
    let path = base_dir.join(TRAY_CONFIG_FILE);
    if path.exists() {
        let contents = fs::read_to_string(&path).context("Failed to read tray config")?;
        let config: TrayConfig = serde_json::from_str(&contents).context("Failed to parse tray config")?;
        return Ok(config);
    }
    let config = TrayConfig::default();
    let payload = serde_json::to_string_pretty(&config).context("Failed to serialize tray config")?;
    fs::write(&path, payload).context("Failed to write tray config")?;
    Ok(config)
}

fn build_command(config: &TrayConfig) -> RecorderCommand {
    if let Some(exe) = config.recorder_exe.clone() {
        let args_prefix = config.recorder_args.clone().unwrap_or_default();
        return RecorderCommand { exe, args_prefix };
    }
    if let Some(exe) = find_default_recorder_exe() {
        return RecorderCommand {
            exe,
            args_prefix: Vec::new(),
        };
    }
    RecorderCommand {
        exe: "cargo".to_string(),
        args_prefix: vec![
            "run".to_string(),
            "--manifest-path".to_string(),
            "tools\\timestone_recorder\\Cargo.toml".to_string(),
            "--".to_string(),
        ],
    }
}


fn find_default_recorder_exe() -> Option<String> {
    let cwd = env::current_dir().ok()?;
    let candidates = [
        "tools\\timestone_recorder\\target\\debug\\timestone_recorder.exe",
        "tools\\timestone_recorder\\target\\release\\timestone_recorder.exe",
    ];
    for candidate in candidates {
        let path = cwd.join(candidate);
        if path.exists() {
            return Some(path.to_string_lossy().to_string());
        }
    }
    None
}

fn find_default_obs_ws_exe() -> Option<String> {
    let cwd = env::current_dir().ok()?;
    let candidates = [
        "tools\\timestone_obs_ws\\target\\debug\\timestone_obs_ws.exe",
        "tools\\timestone_obs_ws\\target\\release\\timestone_obs_ws.exe",
    ];
    for candidate in candidates {
        let path = cwd.join(candidate);
        if path.exists() {
            return Some(path.to_string_lossy().to_string());
        }
    }
    None
}

fn find_default_file_tapper_exe() -> Option<String> {
    let cwd = env::current_dir().ok()?;
    let candidates = [
        "tools\\timestone_file_tapper\\target\\debug\\timestone_file_tapper.exe",
        "tools\\timestone_file_tapper\\target\\release\\timestone_file_tapper.exe",
    ];
    for candidate in candidates {
        let path = cwd.join(candidate);
        if path.exists() {
            return Some(path.to_string_lossy().to_string());
        }
    }
    None
}

fn load_icon(base_dir: &Path, icon_input: Option<&str>) -> Result<HICON> {
    if let Some(input) = icon_input {
        if let Some(path) = resolve_icon_path(base_dir, input)? {
            let wide = to_wide(path.to_string_lossy().as_ref());
            if let Ok(icon) = unsafe {
                LoadImageW(
                    None,
                    PCWSTR(wide.as_ptr()),
                    IMAGE_ICON,
                    0,
                    0,
                    LR_LOADFROMFILE | LR_DEFAULTSIZE,
                )
            } {
                if !icon.is_invalid() {
                    return Ok(HICON(icon.0));
                }
            }
        }
    }
    let fallback = unsafe { LoadIconW(None, PCWSTR::from_raw(32512 as *const u16)) }?;
    Ok(fallback)
}

fn load_icon_with_fallback(base_dir: &Path, icon_input: Option<&str>, fallback: HICON) -> Result<HICON> {
    if let Some(input) = icon_input {
        if let Some(path) = resolve_icon_path(base_dir, input)? {
            let wide = to_wide(path.to_string_lossy().as_ref());
            if let Ok(icon) = unsafe {
                LoadImageW(
                    None,
                    PCWSTR(wide.as_ptr()),
                    IMAGE_ICON,
                    0,
                    0,
                    LR_LOADFROMFILE | LR_DEFAULTSIZE,
                )
            } {
                if !icon.is_invalid() {
                    return Ok(HICON(icon.0));
                }
            }
        }
    }
    Ok(fallback)
}

fn resolve_icon_path(base_dir: &Path, input: &str) -> Result<Option<PathBuf>> {
    if input.starts_with("http://") || input.starts_with("https://") {
        return Ok(download_icon(base_dir, input));
    }
    let path = PathBuf::from(input);
    if path.is_absolute() {
        return Ok(Some(path));
    }
    Ok(Some(base_dir.join(input)))
}

fn download_icon(base_dir: &Path, url: &str) -> Option<PathBuf> {
    let cache_dir = base_dir.join(TRAY_ICON_CACHE);
    if fs::create_dir_all(&cache_dir).is_err() {
        return None;
    }
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    let name = format!("icon_{:x}.ico", hasher.finish());
    let path = cache_dir.join(name);
    if path.exists() {
        return Some(path);
    }
    let response = ureq::get(url).call().ok()?;
    if response.status() != 200 {
        return None;
    }
    let mut reader = response.into_reader();
    let mut file = fs::File::create(&path).ok()?;
    std::io::copy(&mut reader, &mut file).ok()?;
    Some(path)
}

fn update_tray_icon() -> Result<()> {
    let state = STATE.get().context("State not initialized")?.lock().unwrap();
    let icon = match state.status {
        RecorderStatus::Running => match state.mode {
            Mode::Full => state.icon_running_full,
            Mode::Mid => state.icon_running_mid,
            Mode::Low => state.icon_running_low,
        },
        RecorderStatus::Paused => match state.mode {
            Mode::Full => state.icon_paused_full,
            Mode::Mid => state.icon_paused_mid,
            Mode::Low => state.icon_paused_low,
        },
        RecorderStatus::Stopped => state.icon_stopped,
    };
    let status = match state.status {
        RecorderStatus::Running => "running",
        RecorderStatus::Paused => "paused",
        RecorderStatus::Stopped => "stopped",
    };
    let mode = match state.mode {
        Mode::Full => "full",
        Mode::Mid => "mid",
        Mode::Low => "low",
    };
    let tooltip = if state.busy {
        format!("{} ({}, {}, busy)", state.tooltip, status, mode)
    } else {
        format!("{} ({}, {})", state.tooltip, status, mode)
    };
    let tooltip = if matches!(state.status, RecorderStatus::Paused | RecorderStatus::Stopped) {
        let session_id = read_lock_session_id(&state.data_dir.join("recorder.lock"));
        if let Some(summary) = get_latest_processing_summary(&state.db_path, session_id.as_deref()) {
            format!("{} | {}", tooltip, summary)
        } else {
            tooltip
        }
    } else {
        tooltip
    };
    let tooltip = truncate_tooltip(&tooltip, 127);
    let mut data = tray_data(state.hwnd, icon, &tooltip);
    let ok = unsafe { Shell_NotifyIconW(NIM_MODIFY, &mut data) };
    if ok.as_bool() {
        Ok(())
    } else {
        let ok = unsafe { Shell_NotifyIconW(NIM_ADD, &mut data) };
        if ok.as_bool() {
            Ok(())
        } else {
            anyhow::bail!("Failed to update tray icon");
        }
    }
}

fn cleanup_tray_icon() {
    if let Some(state) = STATE.get() {
        let state = state.lock().unwrap();
        let mut data = tray_data(state.hwnd, state.icon_stopped, &state.tooltip);
        unsafe {
            let _ = Shell_NotifyIconW(NIM_DELETE, &mut data);
        }
    }
}

fn register_hotkeys(hwnd: HWND) {
    let none = MOD_NOREPEAT;
    let with_shift = MOD_NOREPEAT | MOD_SHIFT;
    let with_alt = MOD_NOREPEAT | MOD_ALT;
    register_hotkey(hwnd, HOTKEY_F13, none, VK_F13, "F13");
    register_hotkey(hwnd, HOTKEY_SHIFT_F13, with_shift, VK_F13, "Shift+F13");
    register_hotkey(hwnd, HOTKEY_ALT_F13, with_alt, VK_F13, "Alt+F13");
    register_hotkey(hwnd, HOTKEY_F14, none, VK_F14, "F14");
    register_hotkey(hwnd, HOTKEY_SHIFT_F14, with_shift, VK_F14, "Shift+F14");
    register_hotkey(hwnd, HOTKEY_ALT_F14, with_alt, VK_F14, "Alt+F14");
}

fn register_hotkey(hwnd: HWND, id: i32, mods: HOT_KEY_MODIFIERS, vk: u32, label: &str) {
    let result = unsafe { RegisterHotKey(hwnd, id, mods, vk) };
    let Some(state) = STATE.get() else {
        return;
    };
    let data_dir = state.lock().unwrap().data_dir.clone();
    match result {
        Ok(_) => {
            log_line(
                &data_dir,
                &format!("hotkey registered: {label} mods={} vk={}", mods.0, vk),
            );
        }
        Err(err) => {
            log_line(
                &data_dir,
                &format!(
                    "hotkey failed: {label} mods={} vk={} err={}",
                    mods.0,
                    vk,
                    err.code().0
                ),
            );
        }
    }
}

fn unregister_hotkeys(hwnd: HWND) {
    unsafe {
        let _ = UnregisterHotKey(hwnd, HOTKEY_F13);
        let _ = UnregisterHotKey(hwnd, HOTKEY_SHIFT_F13);
        let _ = UnregisterHotKey(hwnd, HOTKEY_ALT_F13);
        let _ = UnregisterHotKey(hwnd, HOTKEY_F14);
        let _ = UnregisterHotKey(hwnd, HOTKEY_SHIFT_F14);
        let _ = UnregisterHotKey(hwnd, HOTKEY_ALT_F14);
    }
}

fn tray_data(hwnd: HWND, icon: HICON, tooltip: &str) -> NOTIFYICONDATAW {
    let mut tip = [0u16; 128];
    let wide = to_wide(tooltip);
    let len = wide.len().min(tip.len() - 1);
    tip[..len].copy_from_slice(&wide[..len]);
    NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: TRAY_ICON_ID,
        uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
        uCallbackMessage: WM_TRAY,
        hIcon: icon,
        szTip: tip,
        ..Default::default()
    }
}

fn truncate_tooltip(value: &str, max_len: usize) -> String {
    if value.len() <= max_len {
        return value.to_string();
    }
    let mut out = value.chars().take(max_len.saturating_sub(1)).collect::<String>();
    out.push('…');
    out
}

fn get_latest_processing_summary(db_path: &Path, session_id: Option<&str>) -> Option<String> {
    let conn = Connection::open(db_path).ok()?;
    let mut stmt = if session_id.is_some() {
        conn.prepare(
            "SELECT summary, segment_id FROM processing_status WHERE session_id = ? ORDER BY updated_ms DESC LIMIT 1",
        )
        .ok()?
    } else {
        conn.prepare("SELECT summary, segment_id FROM processing_status ORDER BY updated_ms DESC LIMIT 1")
            .ok()?
    };
    if let Some(session_id) = session_id {
        stmt.query_row(params![session_id], |row| {
            let summary: String = row.get(0)?;
            let segment_id: i64 = row.get(1)?;
            Ok(format!("{summary} | seg {segment_id}"))
        })
        .ok()
    } else {
        stmt.query_row(params![], |row| {
            let summary: String = row.get(0)?;
            let segment_id: i64 = row.get(1)?;
            Ok(format!("{summary} | seg {segment_id}"))
        })
        .ok()
    }
}

fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn run_command(command: &RecorderCommand, action: &str) -> Result<String> {
    let mut cmd = Command::new(&command.exe);
    cmd.args(&command.args_prefix);
    cmd.arg(action);
    cmd.creation_flags(CREATE_NO_WINDOW.0);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let output = cmd.output().context("Failed to run recorder command")?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() && !stdout.contains("Recorder status") {
        anyhow::bail!(stderr.trim().to_string());
    }
    Ok(format!("{stdout}{stderr}"))
}

fn run_command_async(command: &RecorderCommand, action: &str) -> Result<()> {
    let mut cmd = Command::new(&command.exe);
    cmd.args(&command.args_prefix);
    cmd.arg(action);
    cmd.creation_flags(CREATE_NO_WINDOW.0);
    cmd.stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    cmd.spawn().context("Failed to spawn recorder command")?;
    Ok(())
}

fn send_obs_command(state: &AppState, action: &str) -> Result<bool> {
    let mut cmd = Command::new(&state.obs_ws_exe);
    cmd.arg("--host")
        .arg(&state.obs_host)
        .arg("--port")
        .arg(state.obs_port.to_string())
        .arg("--command")
        .arg(action)
        .creation_flags(CREATE_NO_WINDOW.0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(pass) = &state.obs_password {
        cmd.env("OBS_WS_PASSWORD", pass);
    } else {
        log_line(
            &state.data_dir,
            &format!("OBS password not set. Sending {action} without password."),
        );
    }
    let status = cmd.status().context("Failed to run obs_ws command")?;
    if !status.success() {
        log_line(
            &state.data_dir,
            &format!("OBS command {action} failed with status {status}"),
        );
        return Ok(false);
    }
    Ok(true)
}

fn start_obs_listener(state: &mut AppState) -> Result<()> {
    if let Some(child) = &mut state.obs_ws_child {
        if is_child_running(child) {
            return Ok(());
        }
    }
    let mut cmd = Command::new(&state.obs_ws_exe);
    cmd.arg("--host")
        .arg(&state.obs_host)
        .arg("--port")
        .arg(state.obs_port.to_string())
        .creation_flags(CREATE_NO_WINDOW.0)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(pass) = &state.obs_password {
        cmd.env("OBS_WS_PASSWORD", pass);
    }
    let child = cmd.spawn().context("Failed to start obs_ws listener")?;
    state.obs_ws_child = Some(child);
    Ok(())
}

fn stop_obs_listener(state: &mut AppState) {
    if let Some(mut child) = state.obs_ws_child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn start_file_tapper(state: &mut AppState) -> Result<()> {
    if let Some(child) = &mut state.file_tapper_child {
        if is_child_running(child) {
            return Ok(());
        }
    }
    let lock_path = state.data_dir.join("recorder.lock");
    let session_id = read_lock_session_id(&lock_path).unwrap_or_default();
    if session_id.is_empty() {
        anyhow::bail!("No session id available for file tapper");
    }
    let mut cmd = Command::new(&state.file_tapper_exe);
    cmd.arg("--db")
        .arg(&state.db_path)
        .arg("--session-id")
        .arg(session_id)
        .arg("--quiet-ffmpeg")
        .creation_flags(CREATE_NO_WINDOW.0)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(types) = &state.file_tapper_event_types {
        if !types.is_empty() {
            cmd.arg("--event-types").arg(types.join(","));
        }
    }
    if let Some(mode) = &state.file_tapper_ocr_keydown_mode {
        if !mode.trim().is_empty() {
            cmd.arg("--ocr-keydown-mode").arg(mode);
        }
    }
    if let Some(offset) = state.file_tapper_frame_offset_ms {
        cmd.arg("--frame-offset-ms").arg(offset.to_string());
    }
    let child = cmd.spawn().context("Failed to start file tapper")?;
    state.file_tapper_child = Some(child);
    Ok(())
}

fn stop_file_tapper(state: &mut AppState) {
    if let Some(mut child) = state.file_tapper_child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn is_child_running(child: &mut Child) -> bool {
    child
        .try_wait()
        .map(|status| status.is_none())
        .unwrap_or(false)
}

fn has_pending_processing(db_path: &Path) -> bool {
    let conn = match Connection::open(db_path) {
        Ok(conn) => conn,
        Err(_) => return false,
    };
    let mut stmt = match conn.prepare(
        "SELECT COUNT(*) FROM record_segments WHERE processed = 0 AND end_wall_ms IS NOT NULL",
    ) {
        Ok(stmt) => stmt,
        Err(_) => return false,
    };
    let count: i64 = stmt
        .query_row(params![], |row| row.get(0))
        .unwrap_or(0);
    count > 0
}

fn get_status(command: &RecorderCommand) -> Result<RecorderStatus> {
    let output = run_command(command, "status").unwrap_or_default();
    if output.contains("Recorder status: paused") {
        Ok(RecorderStatus::Paused)
    } else if output.contains("Recorder status: running") {
        Ok(RecorderStatus::Running)
    } else {
        Ok(RecorderStatus::Stopped)
    }
}

fn get_status_from_files(data_dir: &Path) -> RecorderStatus {
    let lock_path = data_dir.join("recorder.lock");
    if !lock_path.exists() {
        let pause_path = data_dir.join("pause.signal");
        let _ = fs::remove_file(pause_path);
        return RecorderStatus::Stopped;
    }
    if let Some(pid) = read_lock_pid(&lock_path) {
        if !is_pid_running(pid) {
            let _ = fs::remove_file(&lock_path);
            let pause_path = data_dir.join("pause.signal");
            let _ = fs::remove_file(pause_path);
            return RecorderStatus::Stopped;
        }
    }
    let pause_path = data_dir.join("pause.signal");
    if pause_path.exists() {
        RecorderStatus::Paused
    } else {
        RecorderStatus::Running
    }
}

fn wait_for_lock(data_dir: &Path, timeout_ms: u64) -> bool {
    let lock_path = data_dir.join("recorder.lock");
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if lock_path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn wait_for_lock_clear(data_dir: &Path, timeout_ms: u64) -> bool {
    let lock_path = data_dir.join("recorder.lock");
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if !lock_path.exists() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn read_lock_pid(lock_path: &Path) -> Option<u32> {
    let contents = fs::read_to_string(lock_path).ok()?;
    for line in contents.lines() {
        let mut parts = line.splitn(2, '=');
        let key = parts.next().unwrap_or("").trim();
        let value = parts.next().unwrap_or("").trim();
        if key == "pid" {
            if let Ok(pid) = value.parse::<u32>() {
                return Some(pid);
            }
        }
    }
    None
}

fn read_lock_session_id(lock_path: &Path) -> Option<String> {
    let contents = fs::read_to_string(lock_path).ok()?;
    for line in contents.lines() {
        let mut parts = line.splitn(2, '=');
        let key = parts.next().unwrap_or("").trim();
        let value = parts.next().unwrap_or("").trim();
        if key == "session_id" && !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
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

fn save_last_mode(data_dir: &Path, mode: Mode) {
    let path = data_dir.join(TRAY_CONFIG_FILE);
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(_) => return,
    };
    let mut config: TrayConfig = serde_json::from_str(&contents).unwrap_or_default();
    config.last_mode = mode;
    if let Ok(payload) = serde_json::to_string_pretty(&config) {
        let _ = fs::write(&path, payload);
    }
}

fn start_session(state: &mut AppState) -> Result<()> {
    log_line(&state.data_dir, "starting session");
    run_command_async(&state.command, "start")?;
    let ok = wait_for_lock(&state.data_dir, 15000);
    if !ok {
        anyhow::bail!("Recorder did not start in time");
    }
    if state.mode == Mode::Full {
        start_obs_listener(state)?;
        if let Ok(started) = send_obs_command(state, "start") {
            state.obs_started = started;
            if started {
                let _ = start_file_tapper(state);
            }
        }
    }
    state.status = RecorderStatus::Running;
    Ok(())
}

fn pause_session(state: &mut AppState) -> Result<()> {
    log_line(&state.data_dir, "pausing session");
    let _ = run_command(&state.command, "pause");
    if state.mode == Mode::Full && state.obs_started {
        let _ = send_obs_command(state, "pause");
    }
    state.status = RecorderStatus::Paused;
    Ok(())
}

fn resume_session(state: &mut AppState) -> Result<()> {
    log_line(&state.data_dir, "resuming session");
    let _ = run_command(&state.command, "resume");
    if state.mode == Mode::Full && state.obs_started {
        let _ = send_obs_command(state, "resume");
        let _ = start_file_tapper(state);
    }
    state.status = RecorderStatus::Running;
    Ok(())
}

fn stop_session(state: &mut AppState) -> Result<()> {
    log_line(&state.data_dir, "stopping session");
    let _ = run_command(&state.command, "stop");
    let _ = wait_for_lock_clear(&state.data_dir, 15000);
    if state.obs_started {
        let _ = send_obs_command(state, "stop");
    }
    stop_file_tapper(state);
    stop_obs_listener(state);
    state.obs_started = false;
    state.status = RecorderStatus::Stopped;
    Ok(())
}

fn set_mode(state: &mut AppState, mode: Mode) -> Result<()> {
    if state.mode == mode {
        return Ok(());
    }
    state.mode = mode;
    save_last_mode(&state.data_dir, mode);
    if state.status == RecorderStatus::Stopped {
        return Ok(());
    }
    if state.status == RecorderStatus::Paused {
        let _ = run_command(&state.command, "resume");
        state.status = RecorderStatus::Running;
    }
    match mode {
        Mode::Full => {
            start_obs_listener(state)?;
            if state.obs_started {
                let _ = send_obs_command(state, "resume");
            } else {
                if let Ok(started) = send_obs_command(state, "start") {
                    state.obs_started = started;
                }
            }
            if state.obs_started {
                let _ = start_file_tapper(state);
            }
        }
        Mode::Mid | Mode::Low => {
            if state.obs_started {
                let _ = send_obs_command(state, "pause");
            }
        }
    }
    Ok(())
}

fn update_status() {
    if let Some(state) = STATE.get() {
        let mut state = state.lock().unwrap();
        let status = get_status_from_files(&state.data_dir);
        if status != state.status {
            state.status = status;
            log_line(&state.data_dir, &format!("status poll changed: {status:?}"));
            let _ = update_tray_icon();
        }
    }
}

fn dispatch_action(action: TrayAction, show_dialog: bool, exit_after: bool) {
    let Some(state) = STATE.get() else {
        return;
    };
    let skip_tray_update = matches!(action, TrayAction::Exit);
    {
        let mut state = state.lock().unwrap();
        if state.busy {
            log_line(&state.data_dir, "Ignored action: busy");
            return;
        }
        state.busy = true;
    }
    if !skip_tray_update {
        let _ = update_tray_icon();
    }
    let state = state.clone();
    std::thread::spawn(move || {
        let mut status = RecorderStatus::Stopped;
        let (data_dir, result) = {
            let mut state = state.lock().unwrap();
            let dir = state.data_dir.clone();
            let result = match action {
                TrayAction::Start => start_session(&mut state),
                TrayAction::StartInMode(mode) => {
                    state.mode = mode;
                    save_last_mode(&state.data_dir, mode);
                    start_session(&mut state)
                }
                TrayAction::Pause => pause_session(&mut state),
                TrayAction::Resume => resume_session(&mut state),
                TrayAction::Stop => stop_session(&mut state),
                TrayAction::SetMode(mode) => set_mode(&mut state, mode),
                TrayAction::Exit => stop_session(&mut state),
            };
            (dir, result)
        };
        if let Some(state) = STATE.get() {
            let mut state = state.lock().unwrap();
            status = state.status;
            state.busy = false;
            log_line(&data_dir, &format!("status updated: {status:?}"));
        }
        if exit_after {
            cleanup_tray_icon();
        } else {
            let _ = update_tray_icon();
        }
        if !exit_after && matches!(status, RecorderStatus::Paused | RecorderStatus::Stopped) {
            std::thread::spawn(|| {
                std::thread::sleep(Duration::from_millis(750));
                let _ = update_tray_icon();
            });
        }
        if show_dialog {
            let hwnd = STATE
                .get()
                .map(|state| state.lock().unwrap().hwnd)
                .unwrap_or(HWND(0));
            if hwnd.0 != 0 {
                show_status_dialog(hwnd, status);
            }
        }
        if exit_after {
            unsafe {
                PostQuitMessage(0);
            }
        }
        if let Err(err) = result {
            log_line(&data_dir, &format!("action error: {err}"));
        }
    });
}

fn show_status_dialog(hwnd: HWND, status: RecorderStatus) {
    let status = match status {
        RecorderStatus::Running => "running",
        RecorderStatus::Paused => "paused",
        RecorderStatus::Stopped => "stopped",
    };
    let message = format!("Recorder status: {status}");
    let wide = to_wide(&message);
    unsafe {
        let _ = MessageBoxW(hwnd, PCWSTR(wide.as_ptr()), PCWSTR(to_wide("Timestone").as_ptr()), MB_OK);
    }
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_TRAY => match lparam.0 as u32 {
            WM_LBUTTONUP => {
                handle_left_click();
                LRESULT(0)
            }
            WM_RBUTTONUP => {
                show_menu(hwnd);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        },
        WM_COMMAND => {
            let cmd = (wparam.0 & 0xffff) as u16;
            handle_menu_command(cmd);
            LRESULT(0)
        }
        WM_HOTKEY => {
            handle_hotkey(wparam.0 as i32);
            LRESULT(0)
        }
        WM_TIMER => {
            update_status();
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn handle_left_click() {
    let action = if let Some(state) = STATE.get() {
        let state = state.lock().unwrap();
        if state.busy {
            return;
        }
        match state.status {
            RecorderStatus::Stopped => TrayAction::Start,
            RecorderStatus::Running => TrayAction::Pause,
            RecorderStatus::Paused => TrayAction::Resume,
        }
    } else {
        return;
    };
    dispatch_action(action, false, false);
}

fn action_for_mode_hotkey(state: &AppState, target_mode: Mode) -> TrayAction {
    match state.status {
        RecorderStatus::Stopped => TrayAction::StartInMode(target_mode),
        RecorderStatus::Running => {
            if state.mode == target_mode {
                TrayAction::Pause
            } else {
                TrayAction::SetMode(target_mode)
            }
        }
        RecorderStatus::Paused => {
            if state.mode == target_mode {
                TrayAction::Resume
            } else {
                TrayAction::SetMode(target_mode)
            }
        }
    }
}

fn action_for_start_hotkey(state: &AppState, target_mode: Mode) -> TrayAction {
    match state.status {
        RecorderStatus::Stopped => TrayAction::StartInMode(target_mode),
        _ => TrayAction::Stop,
    }
}

fn handle_hotkey(id: i32) {
    let Some(state) = STATE.get() else {
        return;
    };
    let action = {
        let state = state.lock().unwrap();
        if state.busy {
            return;
        }
        match id {
            HOTKEY_F13 => action_for_mode_hotkey(&state, Mode::Full),
            HOTKEY_SHIFT_F13 => action_for_mode_hotkey(&state, Mode::Low),
            HOTKEY_ALT_F13 => action_for_mode_hotkey(&state, Mode::Mid),
            HOTKEY_F14 => action_for_start_hotkey(&state, Mode::Full),
            HOTKEY_SHIFT_F14 => action_for_start_hotkey(&state, Mode::Low),
            HOTKEY_ALT_F14 => action_for_start_hotkey(&state, Mode::Mid),
            _ => return,
        }
    };
    dispatch_action(action, false, false);
}

fn handle_menu_command(cmd: u16) {
    if let Some(state) = STATE.get() {
        let state = state.lock().unwrap();
        if state.busy && cmd != CMD_STATUS {
            return;
        }
    }
    match cmd {
        CMD_START => dispatch_action(TrayAction::Start, false, false),
        CMD_PAUSE => dispatch_action(TrayAction::Pause, false, false),
        CMD_RESUME => dispatch_action(TrayAction::Resume, false, false),
        CMD_STOP => dispatch_action(TrayAction::Stop, false, false),
        CMD_MODE_FULL => dispatch_action(TrayAction::SetMode(Mode::Full), false, false),
        CMD_MODE_MID => dispatch_action(TrayAction::SetMode(Mode::Mid), false, false),
        CMD_MODE_LOW => dispatch_action(TrayAction::SetMode(Mode::Low), false, false),
        CMD_STATUS => {
            let (status, hwnd) = if let Some(state) = STATE.get() {
                let mut state = state.lock().unwrap();
                let status = get_status_from_files(&state.data_dir);
                state.status = status;
                (status, state.hwnd)
            } else {
                (RecorderStatus::Stopped, HWND(0))
            };
            let _ = update_tray_icon();
            if hwnd.0 != 0 {
                show_status_dialog(hwnd, status);
            }
        }
        CMD_EXIT => {
            let (should_prompt, hwnd) = STATE
                .get()
                .map(|state| {
                    let state = state.lock().unwrap();
                    (
                        has_pending_processing(&state.db_path) || state.file_tapper_child.is_some(),
                        state.hwnd,
                    )
                })
                .unwrap_or((false, HWND(0)));
            if should_prompt {
                let response = unsafe {
                    let wide = to_wide("Processing still running. Exit anyway?");
                    MessageBoxW(hwnd, PCWSTR(wide.as_ptr()), PCWSTR(to_wide("Timestone").as_ptr()), MB_YESNO)
                };
                if response != IDYES {
                    return;
                }
            }
            dispatch_action(TrayAction::Exit, false, true);
        }
        _ => {}
    }
}

fn show_menu(hwnd: HWND) {
    unsafe {
        let menu = match CreatePopupMenu() {
            Ok(menu) => menu,
            Err(_) => return,
        };
        if menu.0 == 0 {
            return;
        }
        let status = STATE
            .get()
            .map(|state| state.lock().unwrap().status)
            .unwrap_or(RecorderStatus::Stopped);
        let mode = STATE
            .get()
            .map(|state| state.lock().unwrap().mode)
            .unwrap_or(Mode::Full);

        append_item(menu, CMD_START, "Start", status != RecorderStatus::Stopped);
        append_item(menu, CMD_PAUSE, "Pause", status != RecorderStatus::Running);
        append_item(menu, CMD_RESUME, "Resume", status != RecorderStatus::Paused);
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
        let mode_menu = match CreatePopupMenu() {
            Ok(menu) => menu,
            Err(_) => return,
        };
        append_check_item(mode_menu, CMD_MODE_FULL, "Full (Events + Video)", mode == Mode::Full);
        append_check_item(mode_menu, CMD_MODE_MID, "Mid (Events + Clicks)", mode == Mode::Mid);
        append_check_item(mode_menu, CMD_MODE_LOW, "Low (Events Only)", mode == Mode::Low);
        let mode_label = to_wide("Mode");
        let _ = AppendMenuW(menu, MF_POPUP, mode_menu.0 as usize, PCWSTR(mode_label.as_ptr()));
        append_item(menu, CMD_STOP, "Stop", status == RecorderStatus::Stopped);
        append_item(menu, CMD_STATUS, "Status", false);
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
        append_item(menu, CMD_EXIT, "Exit", false);

        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        SetForegroundWindow(hwnd);
        TrackPopupMenu(menu, TPM_LEFTALIGN | TPM_TOPALIGN, pt.x, pt.y, 0, hwnd, None);
        let _ = windows::Win32::UI::WindowsAndMessaging::PostMessageW(hwnd, WM_NULL, WPARAM(0), LPARAM(0));
    }
}

fn append_item(menu: HMENU, id: u16, label: &str, disabled: bool) {
    let wide = to_wide(label);
    let flags = if disabled { MF_STRING | MF_GRAYED } else { MF_STRING };
    unsafe {
        let _ = AppendMenuW(menu, flags, id as usize, PCWSTR(wide.as_ptr()));
    }
}

fn append_check_item(menu: HMENU, id: u16, label: &str, checked: bool) {
    let wide = to_wide(label);
    let mut flags = MF_STRING;
    if checked {
        flags |= MF_CHECKED;
    }
    unsafe {
        let _ = AppendMenuW(menu, flags, id as usize, PCWSTR(wide.as_ptr()));
    }
}
