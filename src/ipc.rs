use serde::Deserialize;
use std::sync::{Arc, Mutex};
use tao::window::Window;
use wry::WebView;

use crate::file_ops;
use crate::fonts;
use crate::state::AppState;

#[derive(Deserialize)]
struct IpcMessage {
    command: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// Persists the geometry the window should come back to. Reads the live-tracked
/// non-maximized rectangle rather than asking the window, which would report the
/// maximized bounds while maximized.
pub fn save_geometry(window: &Window, state: &Arc<Mutex<AppState>>) {
    let (pos, size) = {
        let st = state.lock().unwrap();
        (st.normal_pos, st.normal_size)
    };
    crate::window_state::save_window_state(pos, size, window.is_maximized());
}

fn push_maximized(webview: &WebView, window: &Window) {
    let _ = webview.evaluate_script(&format!("window.__setMaximized({})", window.is_maximized()));
}

fn open_and_send(webview: &WebView, path: &str) {
    match file_ops::read_file(path) {
        Ok(contents) => {
            send_to_js(webview, "file_opened", &serde_json::json!({
                "content": contents,
                "path": path
            }));
        }
        Err(e) => {
            // read_to_string reports non-UTF-8 as InvalidData, whose default
            // message is opaque English about a stream.
            let message = if e.kind() == std::io::ErrorKind::InvalidData {
                "无法打开：这不是 UTF-8 文本文件".to_string()
            } else {
                format!("打开文件失败：{e}")
            };
            send_to_js(webview, "error", &serde_json::json!({ "message": message }));
        }
    }
}

pub fn handle_ipc_message(
    msg: &str,
    webview: &WebView,
    window: &Window,
    state: &Arc<Mutex<AppState>>,
) {
    let parsed: IpcMessage = match serde_json::from_str(msg) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("IPC parse error: {e}");
            return;
        }
    };

    match parsed.command.as_str() {
        "open_file" => {
            let path = parsed.path.or_else(file_ops::pick_open_file);
            if let Some(p) = path {
                open_and_send(webview, &p);
            }
        }
        "save_file" => {
            if let Some(ref content) = parsed.content {
                if let Some(ref path) = parsed.path {
                    match file_ops::write_file(path, content) {
                        Ok(_) => {
                            send_to_js(webview, "file_saved", &serde_json::json!({
                                "path": path
                            }));
                        }
                        Err(e) => send_to_js(webview, "error", &serde_json::json!({
                            "message": format!("保存失败：{e}")
                        })),
                    }
                } else {
                    handle_save_as(webview, parsed.content);
                }
            }
        }
        "save_as" => {
            handle_save_as(webview, parsed.content);
        }
        "set_title" => {
            if let Some(title) = parsed.title {
                window.set_title(&title);
            }
        }
        "window_minimize" => {
            window.set_minimized(true);
        }
        "window_maximize" => {
            window.set_maximized(!window.is_maximized());
            push_maximized(webview, window);
        }
        "window_close" => {
            save_geometry(window, state);
            std::process::exit(0);
        }
        "show_error" => {
            if let Some(message) = parsed.message {
                send_to_js(webview, "error", &serde_json::json!({ "message": message }));
            }
        }
        "list_fonts" => {
            // Enumerated on demand rather than at startup: it costs a few
            // milliseconds, and most launches never open the settings panel.
            let families: Vec<serde_json::Value> = fonts::list_families()
                .into_iter()
                .map(|(name, mono)| serde_json::json!({ "n": name, "m": mono }))
                .collect();
            let _ = webview.evaluate_script(&format!(
                "window.__setFonts({})",
                serde_json::to_string(&families).unwrap()
            ));
        }
        "read_image" => {
            if let Some(ref path) = parsed.path {
                use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
                let encoded = utf8_percent_encode(path, NON_ALPHANUMERIC).to_string();
                let url = format!("http://peekdown.localhost/local-image?{}", encoded);
                let script = format!(
                    "window.__setImage({}, {})",
                    serde_json::to_string(path).unwrap(),
                    serde_json::to_string(&url).unwrap(),
                );
                let _ = webview.evaluate_script(&script);
            }
        }
        "drag_enter" => {
            let _ = webview.evaluate_script(
                "document.getElementById('drop-overlay').classList.add('visible')");
        }
        "drag_leave" => {
            let _ = webview.evaluate_script(
                "document.getElementById('drop-overlay').classList.remove('visible')");
        }
        "ready" => {
            // The window may already have been built maximized from the saved state.
            push_maximized(webview, window);
            let (pending_file, pending_content, pending_title) = {
                let mut st = state.lock().unwrap();
                (st.pending_file.take(), st.pending_content.take(), st.pending_title.take())
            };
            if let Some(p) = pending_file {
                open_and_send(webview, &p);
            } else if let Some(content) = pending_content {
                let title = pending_title.unwrap_or_else(|| "stdin".to_string());
                send_to_js(webview, "stdin_opened", &serde_json::json!({
                    "content": content,
                    "title": title
                }));
            }
        }
        _ => eprintln!("Unknown IPC command: {}", parsed.command),
    }
}

fn handle_save_as(
    webview: &WebView,
    content: Option<String>,
) {
    if let Some(content) = content {
        if let Some(path) = file_ops::pick_save_file() {
            match file_ops::write_file(&path, &content) {
                Ok(_) => {
                    send_to_js(webview, "file_saved", &serde_json::json!({
                        "path": path
                    }));
                }
                Err(e) => send_to_js(webview, "error", &serde_json::json!({
                    "message": format!("保存失败：{e}")
                })),
            }
        }
    }
}

fn send_to_js(webview: &WebView, event: &str, data: &serde_json::Value) {
    let script = format!(
        "window.__fromRust({}, {})",
        serde_json::to_string(event).unwrap(),
        serde_json::to_string(data).unwrap(),
    );
    let _ = webview.evaluate_script(&script);
}
