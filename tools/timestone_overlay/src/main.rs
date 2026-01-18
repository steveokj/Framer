use std::env;
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::sync::OnceLock;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreatePen, CreateSolidBrush, DeleteObject, Ellipse, EndPaint, FillRect, GetStockObject, Rectangle,
    SelectObject, SetBkMode, HBRUSH, HGDIOBJ, NULL_BRUSH, PAINTSTRUCT, PS_SOLID, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostQuitMessage, RegisterClassW,
    SetLayeredWindowAttributes, SetTimer, ShowWindow, TranslateMessage, LWA_COLORKEY, MSG, SW_SHOW, WM_DESTROY,
    WM_LBUTTONDOWN, WM_PAINT, WM_RBUTTONDOWN, WM_TIMER, WNDCLASSW, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_POPUP,
};

static CONFIG: OnceLock<OverlayConfig> = OnceLock::new();
const TIMER_ID: usize = 1;

#[derive(Clone, Copy)]
enum OverlayMode {
    Rect,
    Circle,
}

#[derive(Clone, Copy)]
struct OverlayConfig {
    rect: RECT,
    mode: OverlayMode,
    color: COLORREF,
    pen_width: i32,
    duration_ms: u32,
}

fn to_wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(Some(0)).collect()
}

fn color_from_name(name: &str, fallback: COLORREF) -> COLORREF {
    match name.to_lowercase().as_str() {
        "blue" => COLORREF(0x00ffb000),
        "red" => COLORREF(0x000050ff),
        "green" => COLORREF(0x0000d084),
        _ => fallback,
    }
}

fn main() -> windows::core::Result<()> {
    let mut args = env::args().skip(1);
    let mode = args.next().unwrap_or_default();
    if mode.is_empty() {
        eprintln!("Usage: timestone_overlay rect <left> <top> <right> <bottom> [--duration-ms N] [--color blue]");
        eprintln!("   or: timestone_overlay point <x> <y> [--radius N] [--duration-ms N] [--color red]");
        return Ok(());
    }

    let (mut config, remaining) = if mode == "rect" {
        let left = next_i32(&mut args)?;
        let top = next_i32(&mut args)?;
        let right = next_i32(&mut args)?;
        let bottom = next_i32(&mut args)?;
        (
            OverlayConfig {
                rect: RECT {
                    left,
                    top,
                    right,
                    bottom,
                },
                mode: OverlayMode::Rect,
                color: COLORREF(0x00ffb000),
                pen_width: 3,
                duration_ms: 1500,
            },
            args.collect::<Vec<String>>(),
        )
    } else if mode == "point" {
        let x = next_i32(&mut args)?;
        let y = next_i32(&mut args)?;
        let radius = 14;
        (
            OverlayConfig {
                rect: RECT {
                    left: x - radius,
                    top: y - radius,
                    right: x + radius,
                    bottom: y + radius,
                },
                mode: OverlayMode::Circle,
                color: COLORREF(0x000050ff),
                pen_width: 3,
                duration_ms: 1200,
            },
            args.collect::<Vec<String>>(),
        )
    } else {
        eprintln!("Unknown mode: {mode}");
        return Ok(());
    };

    apply_flags(&mut config, &remaining);
    let _ = CONFIG.set(config);

    unsafe {
        let class_name = to_wide("TimestoneOverlayWindow");
        let hinstance = GetModuleHandleW(None)?;
        let background = CreateSolidBrush(COLORREF(0));
        let wc = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            hInstance: hinstance.into(),
            lpszClassName: PCWSTR(class_name.as_ptr()),
            hbrBackground: HBRUSH(background.0),
            ..Default::default()
        };
        RegisterClassW(&wc);
        let rect = CONFIG.get().unwrap().rect;
        let width = rect.right - rect.left;
        let height = rect.bottom - rect.top;
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            PCWSTR(class_name.as_ptr()),
            PCWSTR(class_name.as_ptr()),
            WS_POPUP,
            rect.left,
            rect.top,
            width.max(1),
            height.max(1),
            HWND(0),
            None,
            hinstance,
            None,
        );
        let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), 0, LWA_COLORKEY);
        ShowWindow(hwnd, SW_SHOW);
        let duration_ms = CONFIG.get().unwrap().duration_ms;
        if duration_ms > 0 {
            SetTimer(hwnd, TIMER_ID, duration_ms, None);
        }

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND(0), 0, 0).into() {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = DeleteObject(HGDIOBJ(background.0));
    }

    Ok(())
}

fn next_i32(args: &mut impl Iterator<Item = String>) -> windows::core::Result<i32> {
    let value = args.next().unwrap_or_default();
    value
        .parse::<i32>()
        .map_err(|_| windows::core::Error::from_win32())
}

fn apply_flags(config: &mut OverlayConfig, args: &[String]) {
    let mut idx = 0;
    let mut radius: Option<i32> = None;
    while idx < args.len() {
        match args[idx].as_str() {
            "--duration-ms" => {
                if let Some(value) = args.get(idx + 1) {
                    if let Ok(parsed) = value.parse::<u32>() {
                        config.duration_ms = parsed;
                    }
                }
                idx += 2;
            }
            "--color" => {
                if let Some(value) = args.get(idx + 1) {
                    config.color = color_from_name(value, config.color);
                }
                idx += 2;
            }
            "--width" => {
                if let Some(value) = args.get(idx + 1) {
                    if let Ok(parsed) = value.parse::<i32>() {
                        config.pen_width = parsed.max(1);
                    }
                }
                idx += 2;
            }
            "--radius" => {
                if let Some(value) = args.get(idx + 1) {
                    if let Ok(parsed) = value.parse::<i32>() {
                        radius = Some(parsed.max(2));
                    }
                }
                idx += 2;
            }
            _ => {
                idx += 1;
            }
        }
    }

    if matches!(config.mode, OverlayMode::Circle) {
        if let Some(r) = radius {
            let center_x = (config.rect.left + config.rect.right) / 2;
            let center_y = (config.rect.top + config.rect.bottom) / 2;
            config.rect = RECT {
                left: center_x - r,
                top: center_y - r,
                right: center_x + r,
                bottom: center_y + r,
            };
        }
    }
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            paint_overlay(hwnd);
            LRESULT(0)
        }
        WM_TIMER => {
            if wparam.0 as usize == TIMER_ID {
                PostQuitMessage(0);
            }
            LRESULT(0)
        }
        WM_LBUTTONDOWN | WM_RBUTTONDOWN => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

#[allow(unsafe_op_in_unsafe_fn)]
unsafe fn paint_overlay(hwnd: HWND) {
    let Some(config) = CONFIG.get().copied() else {
        return;
    };
    let mut ps = PAINTSTRUCT::default();
    let hdc = BeginPaint(hwnd, &mut ps);
    let rect = RECT {
        left: 0,
        top: 0,
        right: config.rect.right - config.rect.left,
        bottom: config.rect.bottom - config.rect.top,
    };
    let bg = CreateSolidBrush(COLORREF(0));
    FillRect(hdc, &rect, bg);
    let _ = DeleteObject(HGDIOBJ(bg.0));

    let pen = CreatePen(PS_SOLID, config.pen_width, config.color);
    let old_pen = SelectObject(hdc, HGDIOBJ(pen.0));
    let old_brush = SelectObject(hdc, GetStockObject(NULL_BRUSH));
    SetBkMode(hdc, TRANSPARENT);

    match config.mode {
        OverlayMode::Rect => {
            let _ = Rectangle(hdc, rect.left, rect.top, rect.right, rect.bottom);
        }
        OverlayMode::Circle => {
            let _ = Ellipse(hdc, rect.left, rect.top, rect.right, rect.bottom);
        }
    }

    let _ = SelectObject(hdc, old_pen);
    let _ = SelectObject(hdc, old_brush);
    let _ = DeleteObject(HGDIOBJ(pen.0));
    EndPaint(hwnd, &ps);
}
