#![windows_subsystem = "windows"]

use std::borrow::Cow;
use std::io::Read;
use std::sync::{Arc, Mutex};
use tao::{
    dpi::{PhysicalPosition, PhysicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    window::WindowBuilder,
};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_ASYNCWINDOWPOS, SWP_NOACTIVATE, SWP_NOZORDER};
use wry::{WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

mod app_config;
mod file_assoc;
mod file_ops;
mod fonts;
mod ipc;
mod single_instance;
mod state;
mod window_state;

const INDEX_HTML: &str = include_str!("frontend/index.html");
const STYLE_CSS: &str = include_str!("frontend/style.css");
const APP_JS: &str = include_str!("frontend/app.js");
const EDITOR_JS: &str = include_str!("frontend/editor.js");
const PREVIEW_JS: &str = include_str!("frontend/preview.js");
const TABS_JS: &str = include_str!("frontend/tabs.js");
const SETTINGS_JS: &str = include_str!("frontend/settings.js");
const MARKED_JS: &str = include_str!("frontend/marked.min.js");
const HLJS: &str = include_str!("frontend/highlight.min.js");

#[derive(Debug)]
enum UserEvent {
    IpcMessage(String),
    /// A second process handed us its command line. The payload is a file path,
    /// or empty when it was launched with no file and only wants us in front.
    HandOff(String),
}

fn main() {
    let app_state = Arc::new(Mutex::new(state::AppState::new()));

    // Parse CLI args
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut cli_file: Option<String> = None;
    let mut stdin_flag = false;
    let mut title_arg: Option<String> = None;
    {
        let mut i = 0;
        while i < args.len() {
            match args[i].as_str() {
                "--stdin" => stdin_flag = true,
                "--title" => {
                    if i + 1 < args.len() {
                        i += 1;
                        title_arg = Some(args[i].clone());
                    }
                }
                _ => {
                    if cli_file.is_none() {
                        cli_file = Some(args[i].clone());
                    }
                }
            }
            i += 1;
        }
    }

    // Read stdin if --stdin flag and stdin is a pipe/file (not a console)
    if stdin_flag {
        extern "system" {
            fn GetStdHandle(nStdHandle: u32) -> isize;
            fn GetFileType(hFile: isize) -> u32;
        }
        const STD_INPUT_HANDLE: u32 = 0xFFFF_FFF6; // (DWORD)-10
        const FILE_TYPE_DISK: u32 = 0x0001;
        const FILE_TYPE_PIPE: u32 = 0x0003;

        let is_piped = unsafe {
            let handle = GetStdHandle(STD_INPUT_HANDLE);
            let ft = GetFileType(handle);
            ft == FILE_TYPE_PIPE || ft == FILE_TYPE_DISK
        };
        if is_piped {
            let mut buf = String::new();
            if std::io::stdin().read_to_string(&mut buf).is_ok() && !buf.is_empty() {
                let mut st = app_state.lock().unwrap();
                st.pending_content = Some(buf);
                st.pending_title = title_arg;
            }
        }
    }

    // Register file associations (HKCU, no elevation). Idempotent — safe on every
    // startup. Writes .md / .txt / .log etc. to point at this exe.
    file_assoc::register();

    // Single-instance gate. Only while 多标签 is on: with it off, every launch is
    // meant to be its own window, which is what a plain second process already
    // gives us. Checked before the event loop so a handoff costs no UI at all.
    let multitab = app_config::multitab_enabled();
    if multitab {
        if let single_instance::Role::Secondary = single_instance::claim() {
            if single_instance::hand_off(cli_file.as_deref()) {
                return;
            }
            // Nobody was listening after all — fall through and open normally
            // rather than exiting and looking like the double-click did nothing.
        }
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy: EventLoopProxy<UserEvent> = event_loop.create_proxy();

    if multitab {
        let proxy_handoff = proxy.clone();
        single_instance::listen(move |payload| {
            let _ = proxy_handoff.send_event(UserEvent::HandOff(payload));
        });
    }

    // Monitors are only enumerable once the event loop exists, and the saved
    // rectangle has to be checked against them before the window is built.
    let monitors: Vec<(i32, i32, u32, u32)> = event_loop
        .available_monitors()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            (p.x, p.y, s.width, s.height)
        })
        .collect();
    let saved = window_state::fit_to_monitors(window_state::load_window_state(), &monitors);
    {
        let mut st = app_state.lock().unwrap();
        st.normal_pos = (saved.x, saved.y);
        st.normal_size = (saved.width, saved.height);
    }

    let window = WindowBuilder::new()
        .with_title("notepad - 未命名")
        .with_decorations(false)
        .with_inner_size(PhysicalSize::new(saved.width, saved.height))
        .with_position(PhysicalPosition::new(saved.x, saved.y))
        .with_maximized(saved.maximized)
        // Built hidden, revealed once the frontend has painted its first
        // document. A visible window shows the entire boot: a blank frame while
        // WebView2 starts, the default theme until settings.js runs last, an
        // empty untitled tab from DOMContentLoaded, and only then the file that
        // was double-clicked.
        .with_visible(false)
        .build(&event_loop)
        .unwrap();

    let full_html = build_html();
    {
        app_state.lock().unwrap().html = full_html;
    }

    let proxy_ipc = proxy.clone();
    let proxy_drop = proxy.clone();

    let state_proto = Arc::clone(&app_state);
    let _webview = WebViewBuilder::new()
        .with_custom_protocol("peekdown".to_string(), move |_id, request| {
            let uri = request.uri().path();
            if uri == "/" || uri == "/index.html" {
                let st = state_proto.lock().unwrap();
                wry::http::Response::builder()
                    .header("Content-Type", "text/html")
                    .body(Cow::Owned(st.html.as_bytes().to_vec()))
                    .unwrap()
            } else if uri.starts_with("/local-image") {
                let query = request.uri().query().unwrap_or("");
                let file_path = percent_encoding::percent_decode_str(query)
                    .decode_utf8_lossy()
                    .to_string();
                match std::fs::read(&file_path) {
                    Ok(data) => {
                        let ext = std::path::Path::new(&file_path)
                            .extension()
                            .and_then(|e| e.to_str())
                            .unwrap_or("")
                            .to_lowercase();
                        let mime = match ext.as_str() {
                            "png" => "image/png",
                            "jpg" | "jpeg" => "image/jpeg",
                            "gif" => "image/gif",
                            "svg" => "image/svg+xml",
                            "webp" => "image/webp",
                            "bmp" => "image/bmp",
                            "ico" => "image/x-icon",
                            "tiff" | "tif" => "image/tiff",
                            _ => "application/octet-stream",
                        };
                        wry::http::Response::builder()
                            .header("Content-Type", mime)
                            .body(Cow::Owned(data))
                            .unwrap()
                    }
                    Err(_) => wry::http::Response::builder()
                        .status(404)
                        .body(Cow::Borrowed(b"Image not found" as &[u8]))
                        .unwrap(),
                }
            } else {
                wry::http::Response::builder()
                    .status(404)
                    .body(Cow::Borrowed(b"Not found" as &[u8]))
                    .unwrap()
            }
        })
        .with_url("http://peekdown.localhost/")
        .with_ipc_handler(move |request| {
            let body = request.body().to_string();
            let _ = proxy_ipc.send_event(UserEvent::IpcMessage(body));
        })
        .with_new_window_req_handler(|_| false)
        .with_drag_drop_handler(move |event| {
            match event {
                wry::DragDropEvent::Enter { .. } => {
                    let msg = serde_json::json!({"command": "drag_enter"}).to_string();
                    let _ = proxy_drop.send_event(UserEvent::IpcMessage(msg));
                }
                wry::DragDropEvent::Drop { paths, .. } => {
                    let leave = serde_json::json!({"command": "drag_leave"}).to_string();
                    let _ = proxy_drop.send_event(UserEvent::IpcMessage(leave));
                    // No extension whitelist: a .mdx / .mdown / extensionless
                    // note used to be dropped on the floor with no feedback at
                    // all. Anything that is not valid UTF-8 gets a real error
                    // message from the read instead.
                    let mut sent = 0;
                    for path in &paths {
                        if path.is_dir() {
                            continue;
                        }
                        let msg = serde_json::json!({
                            "command": "open_file",
                            "path": path.to_string_lossy()
                        })
                        .to_string();
                        let _ = proxy_drop.send_event(UserEvent::IpcMessage(msg));
                        sent += 1;
                    }
                    if sent == 0 {
                        let msg = serde_json::json!({
                            "command": "show_error",
                            "message": "只能拖入文件，不支持文件夹"
                        })
                        .to_string();
                        let _ = proxy_drop.send_event(UserEvent::IpcMessage(msg));
                    }
                }
                wry::DragDropEvent::Leave => {
                    let msg = serde_json::json!({"command": "drag_leave"}).to_string();
                    let _ = proxy_drop.send_event(UserEvent::IpcMessage(msg));
                }
                _ => {}
            }
            true
        })
        .with_browser_accelerator_keys(false)
        .with_devtools(true)
        .build(&window)
        .expect("Failed to build WebView");

    // Store CLI file path to open once JS is ready
    if let Some(file_path) = cli_file {
        app_state.lock().unwrap().pending_file = Some(file_path);
    }

    // JS mirrors this to pick the maximize vs. restore glyph. Windows can change
    // it behind our back (double-clicking the drag region, Win+Up, edge snap),
    // so the value is pushed from here rather than guessed in the click handler.
    let mut last_maximized = saved.maximized;

    // Reveal bookkeeping for the hidden window above.
    let mut window_visible = false;
    let want_maximized = saved.maximized;
    // Last-resort net: if the frontend never reports in — WebView2 failed to
    // start, a JS exception landed before __bootDone — the window still has to
    // appear rather than leaving a process with no window at all. Long enough
    // that a cold WebView2 start never trips it; tripping it just means the old
    // visible-boot behaviour, not a broken app.
    let show_deadline = std::time::Instant::now() + std::time::Duration::from_millis(2500);

    event_loop.run(move |event, _, control_flow| {
        *control_flow = if window_visible {
            ControlFlow::Wait
        } else {
            // Wait, but not past the fallback — otherwise a launch that produces
            // no further events would never reach the deadline check below.
            ControlFlow::WaitUntil(show_deadline)
        };

        match event {
            Event::UserEvent(UserEvent::IpcMessage(msg)) => {
                ipc::handle_ipc_message(&msg, &_webview, &window, &app_state);
            }
            Event::UserEvent(UserEvent::HandOff(payload)) => {
                // Whatever else happens, the window the user just double-clicked
                // towards has to come forward — it may be minimized or buried.
                window.set_minimized(false);
                window.set_visible(true);
                window.set_focus();
                if !payload.is_empty() {
                    let msg = serde_json::json!({
                        "command": "open_file",
                        "path": payload
                    })
                    .to_string();
                    ipc::handle_ipc_message(&msg, &_webview, &window, &app_state);
                }
            }
            Event::WindowEvent {
                event: WindowEvent::Resized(new_size),
                ..
            } => {
                let w = new_size.width as i32;
                let h = new_size.height as i32;
                unsafe {
                    let controller = _webview.controller();
                    let _ = controller.SetBounds(RECT { left: 0, top: 0, right: w, bottom: h });
                    let mut host = HWND::default();
                    if controller.ParentWindow(&mut host).is_ok() {
                        let _ = SetWindowPos(host, None, 0, 0, w, h,
                            SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_NOZORDER);
                    }
                }
                let maximized = window.is_maximized();
                // Minimizing also fires Resized, with a 0x0 size — recording it
                // would persist a degenerate window for the next launch.
                if !maximized && new_size.width > 0 && new_size.height > 0 {
                    app_state.lock().unwrap().normal_size = (new_size.width, new_size.height);
                }
                if maximized != last_maximized {
                    last_maximized = maximized;
                    let _ = _webview
                        .evaluate_script(&format!("window.__setMaximized({maximized})"));
                }
            }
            Event::WindowEvent {
                event: WindowEvent::Moved(new_pos),
                ..
            } => {
                // Windows parks minimized windows at -32000 and still reports
                // them as not maximized, so filter that out before recording.
                let parked = new_pos.x < -30000 || new_pos.y < -30000;
                if !parked && !window.is_maximized() {
                    app_state.lock().unwrap().normal_pos = (new_pos.x, new_pos.y);
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                ipc::save_geometry(&window, &app_state);
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }

        if !window_visible {
            let requested = app_state.lock().unwrap().show_requested;
            if requested || std::time::Instant::now() >= show_deadline {
                window.set_visible(true);
                // A window that has never been shown can have its builder-time
                // maximize deferred by Windows, so re-assert it instead of
                // trusting it survived the hidden phase.
                if want_maximized && !window.is_maximized() {
                    window.set_maximized(true);
                }
                window_visible = true;
            }
        }
    });
}

fn escape_for_script_tag(js: &str) -> String {
    // Prevent "</script" in JS from prematurely closing the <script> tag
    js.replace("</script", "<\\/script")
}

fn build_html() -> String {
    // Build script tags with escaped content.
    // settings.js goes last: it reads the DOM and app.js helpers at parse time.
    let scripts = format!(
        "<script>{}</script>\n<script>{}</script>\n<script>{}</script>\n<script>{}</script>\n<script>{}</script>\n<script>{}</script>\n<script>{}</script>",
        escape_for_script_tag(HLJS),
        escape_for_script_tag(MARKED_JS),
        escape_for_script_tag(PREVIEW_JS),
        escape_for_script_tag(TABS_JS),
        escape_for_script_tag(EDITOR_JS),
        escape_for_script_tag(APP_JS),
        escape_for_script_tag(SETTINGS_JS),
    );

    INDEX_HTML
        .replace("/* __CSS__ */", STYLE_CSS)
        .replace("__VERSION__", env!("CARGO_PKG_VERSION"))
        .replace("<!-- __SCRIPTS__ -->", &scripts)
}
