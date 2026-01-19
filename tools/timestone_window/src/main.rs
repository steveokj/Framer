use std::env;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateSolidBrush, DeleteObject, GetStockObject, HBRUSH, GET_STOCK_OBJECT_FLAGS,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostQuitMessage, RegisterClassW, ShowWindow,
    TranslateMessage, CW_USEDEFAULT, MSG, SW_SHOW, WM_DESTROY, WNDCLASSW, WS_OVERLAPPEDWINDOW,
};

fn to_wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn parse_arg(args: &[String], name: &str, default: i32) -> i32 {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|idx| args.get(idx + 1))
        .and_then(|value| value.parse::<i32>().ok())
        .unwrap_or(default)
}

fn parse_arg_string(args: &[String], name: &str, default: &str) -> String {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|idx| args.get(idx + 1))
        .cloned()
        .unwrap_or_else(|| default.to_string())
}

fn main() -> windows::core::Result<()> {
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    let args: Vec<String> = env::args().collect();
    let x = parse_arg(&args, "--x", CW_USEDEFAULT);
    let y = parse_arg(&args, "--y", CW_USEDEFAULT);
    let width = parse_arg(&args, "--w", 800);
    let height = parse_arg(&args, "--h", 600);
    let title = parse_arg_string(&args, "--title", "Timestone Test Window");

    unsafe {
        let class_name = to_wide("TimestoneWindowClass");
        let hinstance = GetModuleHandleW(None)?;
        let bg: HBRUSH = if let Some(idx) = args.iter().position(|arg| arg == "--color") {
            let value = args.get(idx + 1).map(String::as_str).unwrap_or("#223344");
            let rgb = parse_color(value);
            CreateSolidBrush(rgb)
        } else {
            HBRUSH(GetStockObject(GET_STOCK_OBJECT_FLAGS(5)).0)
        };
        let wc = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: hinstance.into(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            hbrBackground: bg,
            ..Default::default()
        };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(
            Default::default(),
            PCWSTR(class_name.as_ptr()),
            PCWSTR(to_wide(&title).as_ptr()),
            WS_OVERLAPPEDWINDOW,
            x,
            y,
            width,
            height,
            HWND(0),
            None,
            hinstance,
            None,
        );
        ShowWindow(hwnd, SW_SHOW);

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND(0), 0, 0).into() {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        if args.iter().position(|arg| arg == "--color").is_some() {
            let _ = DeleteObject(bg);
        }
    }

    Ok(())
}

fn parse_color(value: &str) -> windows::Win32::Foundation::COLORREF {
    let trimmed = value.trim().trim_start_matches('#');
    if trimmed.len() == 6 {
        if let Ok(hex) = u32::from_str_radix(trimmed, 16) {
            let r = (hex >> 16) & 0xff;
            let g = (hex >> 8) & 0xff;
            let b = hex & 0xff;
            return windows::Win32::Foundation::COLORREF((b << 16) | (g << 8) | r);
        }
    }
    windows::Win32::Foundation::COLORREF(0x00443322)
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
