//! Single-instance handoff, used only while 多标签 is enabled.
//!
//! When it is on, double-clicking a file should land in the running window as a
//! new tab. Windows still starts a fresh process for every double-click, so that
//! process has to notice the first one, pass its path over and exit.
//!
//! The mechanism is a named mutex for detection plus a named auto-reset event
//! for the wake-up, with the paths themselves passed as small files in a handoff
//! directory. A named pipe would do the same job, but this way the payload rides
//! on `std::fs` and only six kernel32 calls are hand-declared — the same
//! trade-off `fonts.rs` and `file_ops.rs` already make.

use std::ffi::c_void;
use std::fs;
use std::path::PathBuf;

const MUTEX_NAME: &str = "Local\\notepads-singleton";
const EVENT_NAME: &str = "Local\\notepads-handoff";

const ERROR_ALREADY_EXISTS: u32 = 183;
const WAIT_OBJECT_0: u32 = 0;
const INFINITE: u32 = 0xFFFF_FFFF;

#[link(name = "kernel32")]
extern "system" {
    fn CreateMutexW(attrs: *const c_void, initial_owner: i32, name: *const u16) -> isize;
    fn CreateEventW(attrs: *const c_void, manual_reset: i32, initial: i32, name: *const u16) -> isize;
    fn OpenEventW(desired_access: u32, inherit: i32, name: *const u16) -> isize;
    fn SetEvent(handle: isize) -> i32;
    fn WaitForSingleObject(handle: isize, millis: u32) -> u32;
    fn GetLastError() -> u32;
}

const EVENT_MODIFY_STATE: u32 = 0x0002;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn handoff_dir() -> PathBuf {
    crate::app_config::config_dir().join("handoff")
}

/// Whether this process is the one that owns the window.
pub enum Role {
    First,
    Secondary,
}

/// The mutex handle is deliberately never closed: it has to outlive everything
/// else in the process, and Windows releases it on exit anyway.
pub fn claim() -> Role {
    let name = wide(MUTEX_NAME);
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if handle == 0 {
            // Without a mutex there is no way to tell first from second, and
            // silently exiting would be much worse than an extra window.
            return Role::First;
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            Role::Secondary
        } else {
            Role::First
        }
    }
}

/// Hands a path (or `None`, meaning "just come to the front") to the running
/// instance. Returns false if nothing was listening, in which case the caller
/// should carry on and open its own window rather than exiting into nowhere.
pub fn hand_off(path: Option<&str>) -> bool {
    let dir = handoff_dir();
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }
    // Unique per message: two files double-clicked at once produce two
    // processes, and one overwriting the other's payload would lose a document.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file = dir.join(format!("{}-{}", std::process::id(), stamp));
    if fs::write(&file, path.unwrap_or("")).is_err() {
        return false;
    }

    let name = wide(EVENT_NAME);
    unsafe {
        let event = OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr());
        if event == 0 {
            // The mutex existed but the listener does not — a torn-down or
            // still-starting instance. Take the file back so it cannot be
            // delivered later out of nowhere.
            let _ = fs::remove_file(&file);
            return false;
        }
        SetEvent(event) != 0
    }
}

/// Runs the listener for the lifetime of the process, calling `on_open` with
/// each handed-over path (empty string = "just focus").
pub fn listen<F>(on_open: F)
where
    F: Fn(String) + Send + 'static,
{
    let name = wide(EVENT_NAME);
    let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, name.as_ptr()) };
    if event == 0 {
        return;
    }
    // Anything left by a crashed run would otherwise be delivered at the next
    // launch, opening files the user did not ask for.
    let dir = handoff_dir();
    let _ = fs::remove_dir_all(&dir);

    std::thread::spawn(move || loop {
        if unsafe { WaitForSingleObject(event, INFINITE) } != WAIT_OBJECT_0 {
            return;
        }
        // Drain: one event can cover several files, since the event is
        // auto-reset and two senders may signal before this thread wakes.
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if let Ok(payload) = fs::read_to_string(&path) {
                let _ = fs::remove_file(&path);
                on_open(payload);
            }
        }
    });
}
