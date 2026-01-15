use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::env;
use std::fs;
use std::hash::{Hash, Hasher};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, LRESULT, POINT, STILL_ACTIVE, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, CREATE_NO_WINDOW, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{
    Shell_NotifyIconW, NOTIFYICONDATAW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY,
};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos,
    GetMessageW, LoadIconW, LoadImageW, MessageBoxW, PostQuitMessage, RegisterClassW, SetForegroundWindow, SetTimer,
    TrackPopupMenu, TranslateMessage, CW_USEDEFAULT, HICON, HMENU, IMAGE_ICON, LR_DEFAULTSIZE, LR_LOADFROMFILE, MB_OK,
    MF_GRAYED, MF_SEPARATOR, MF_STRING, TPM_LEFTALIGN, TPM_TOPALIGN, WM_COMMAND, WM_DESTROY, WM_LBUTTONUP, WM_RBUTTONUP,
    WM_NULL, WM_TIMER, WM_USER, WNDCLASSW, WS_OVERLAPPEDWINDOW,
};

const APP_DIR: &str = "data\\timestone";
const TRAY_CONFIG_FILE: &str = "tray_config.json";
const TRAY_ICON_CACHE: &str = "tray_icons";

const TRAY_ICON_ID: u32 = 1;
const WM_TRAY: u32 = WM_USER + 1;
const TIMER_ID: usize = 1;
const TIMER_MS: u32 = 5000;

const CMD_START: u16 = 1001;
const CMD_PAUSE: u16 = 1002;
const CMD_RESUME: u16 = 1003;
const CMD_STOP: u16 = 1004;
const CMD_STATUS: u16 = 1005;
const CMD_EXIT: u16 = 1006;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct TrayConfig {
    icon_running: Option<String>,
    icon_paused: Option<String>,
    icon_stopped: Option<String>,
    tooltip: Option<String>,
    recorder_exe: Option<String>,
    recorder_args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecorderStatus {
    Running,
    Paused,
    Stopped,
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
    icon_running: HICON,
    icon_paused: HICON,
    icon_stopped: HICON,
    status: RecorderStatus,
    busy: bool,
}

static STATE: OnceLock<Arc<Mutex<AppState>>> = OnceLock::new();

fn main() -> Result<()> {
    let base_dir = ensure_app_dir()?;
    let config = load_or_create_config(&base_dir)?;
    let command = build_command(&config);
    let data_dir = base_dir.clone();
    let tooltip = config
        .tooltip
        .clone()
        .unwrap_or_else(|| "Timestone Recorder".to_string());

    let icon_running = load_icon(&base_dir, config.icon_running.as_deref())?;
    let icon_paused = load_icon(&base_dir, config.icon_paused.as_deref())?;
    let icon_stopped = load_icon(&base_dir, config.icon_stopped.as_deref())?;

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
            icon_running,
            icon_paused,
            icon_stopped,
            status,
            busy: false,
        };
        let shared = Arc::new(Mutex::new(state));
        let _ = STATE.set(shared);
        update_tray_icon()?;
        let _ = SetTimer(hwnd, TIMER_ID, TIMER_MS, None);

        let mut msg = std::mem::zeroed();
        while GetMessageW(&mut msg, HWND(0), 0, 0).into() {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
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
        RecorderStatus::Running => state.icon_running,
        RecorderStatus::Paused => state.icon_paused,
        RecorderStatus::Stopped => state.icon_stopped,
    };
    let status = match state.status {
        RecorderStatus::Running => "running",
        RecorderStatus::Paused => "paused",
        RecorderStatus::Stopped => "stopped",
    };
    let tooltip = if state.busy {
        format!("{} ({}, busy)", state.tooltip, status)
    } else {
        format!("{} ({})", state.tooltip, status)
    };
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

fn update_status() {
    if let Some(state) = STATE.get() {
        let mut state = state.lock().unwrap();
        let status = get_status_from_files(&state.data_dir);
        if status != state.status {
            state.status = status;
            let _ = update_tray_icon();
        }
    }
}

fn dispatch_command(action: &str, show_dialog: bool) {
    let Some(state) = STATE.get() else {
        return;
    };
    {
        let mut state = state.lock().unwrap();
        if state.busy {
            return;
        }
        state.busy = true;
    }
    let _ = update_tray_icon();
    let state = state.clone();
    let action = action.to_string();
    std::thread::spawn(move || {
        let command = { state.lock().unwrap().command.clone() };
        let data_dir = { state.lock().unwrap().data_dir.clone() };
        println!("[tray] command requested: {}", action);
        let result = if action == "start" {
            run_command_async(&command, &action).map(|_| {
                println!("[tray] waiting for recorder to start...");
                wait_for_lock(&data_dir, 15000)
            })
        } else if action == "stop" {
            run_command(&command, &action).map(|output| {
                if !output.trim().is_empty() {
                    println!("[tray] {}", output.trim());
                }
                println!("[tray] waiting for recorder to stop...");
                wait_for_lock_clear(&data_dir, 15000)
            })
        } else {
            run_command(&command, &action).map(|output| {
                if !output.trim().is_empty() {
                    println!("[tray] {}", output.trim());
                }
                true
            })
        };

        let started = result.unwrap_or(false);
        let status = if started {
            get_status_from_files(&data_dir)
        } else {
            RecorderStatus::Stopped
        };
        if let Some(state) = STATE.get() {
            let mut state = state.lock().unwrap();
            state.status = status;
            state.busy = false;
        }
        let _ = update_tray_icon();
        if show_dialog {
            let hwnd = STATE
                .get()
                .map(|state| state.lock().unwrap().hwnd)
                .unwrap_or(HWND(0));
            if hwnd.0 != 0 {
                show_status_dialog(hwnd, status);
            }
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
            RecorderStatus::Stopped => "start",
            RecorderStatus::Running => "pause",
            RecorderStatus::Paused => "resume",
        }
    } else {
        return;
    };
    dispatch_command(action, false);
}

fn handle_menu_command(cmd: u16) {
    if let Some(state) = STATE.get() {
        let state = state.lock().unwrap();
        if state.busy && cmd != CMD_STATUS {
            return;
        }
    }
    match cmd {
        CMD_START => dispatch_command("start", false),
        CMD_PAUSE => dispatch_command("pause", false),
        CMD_RESUME => dispatch_command("resume", false),
        CMD_STOP => dispatch_command("stop", false),
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
            dispatch_command("stop", false);
            unsafe {
                PostQuitMessage(0);
            }
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
        let status = STATE.get().map(|state| state.lock().unwrap().status).unwrap_or(RecorderStatus::Stopped);
        append_item(menu, CMD_START, "Start", status != RecorderStatus::Stopped);
        append_item(menu, CMD_PAUSE, "Pause", status != RecorderStatus::Running);
        append_item(menu, CMD_RESUME, "Resume", status != RecorderStatus::Paused);
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
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
