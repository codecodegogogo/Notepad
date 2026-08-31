//! Settings that Rust needs before the WebView exists.
//!
//! Everything else the user can configure lives in localStorage, which is the
//! right place for it — but "多标签" decides whether a second launch should hand
//! its file to the running process and exit, and that has to be answered before
//! a window, let alone a WebView, is created. So the frontend mirrors this one
//! flag out to disk through the `set_multitab` IPC command.

use std::fs;
use std::path::PathBuf;

pub fn config_dir() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("notepad");
    p
}

fn multitab_path() -> PathBuf {
    config_dir().join("multitab")
}

/// Defaults to enabled: that is the behaviour the app already had, so an
/// existing user who never opens the setting sees nothing change.
pub fn multitab_enabled() -> bool {
    match fs::read_to_string(multitab_path()) {
        Ok(s) => s.trim() != "0",
        Err(_) => true,
    }
}

pub fn set_multitab(enabled: bool) {
    let path = multitab_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, if enabled { "1" } else { "0" });
}
