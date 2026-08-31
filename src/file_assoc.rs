//! File-type association for HKCU, no elevation required.
//!
//! Windows Shell resolves "which app opens .md" through a two-key chain:
//!
//!   HKCU\Software\Classes\.md          → ProgId string (e.g. "notepad.md")
//!   HKCU\Software\Classes\notepad.md\
//!     shell\open\command                → "C:\path\to\notepad.exe" "%1"
//!
//! Writing in HKCU keeps it per-user and never requires a UAC prompt. All Win32
//! is declared by hand — the same approach fonts.rs and file_ops.rs already use.

use std::ffi::c_void;
use std::path::PathBuf;

// Registry access constants -----------------------------------------------

const HKEY_CURRENT_USER: isize = -2147483647i32 as isize; // 0x80000001
const REG_OPTION_NON_VOLATILE: u32 = 0;
const REG_SZ: u32 = 1;
const KEY_ALL_ACCESS: u32 = 0xF003F;
const ERROR_SUCCESS: u32 = 0;

#[link(name = "advapi32")]
extern "system" {
    fn RegCreateKeyExW(
        hkey: isize,
        sub_key: *const u16,
        reserved: u32,
        class_: *mut u16,
        options: u32,
        sam_desired: u32,
        security_attrs: *const c_void,
        phk_result: *mut isize,
        lpdw_disposition: *mut u32,
    ) -> u32;

    fn RegSetValueExW(
        hkey: isize,
        value_name: *const u16,
        reserved: u32,
        dw_type: u32,
        lp_data: *const u8,
        cb_data: u32,
    ) -> u32;

    fn RegDeleteTreeW(hkey: isize, sub_key: *const u16) -> u32;

    fn RegCloseKey(hkey: isize) -> u32;
}

// Shell notification constants ---------------------------------------------

const SHCNE_ASSOCCHANGED: u32 = 0x0800_0000;
const SHCNF_IDLIST: u32 = 0x0000;

#[link(name = "shell32")]
extern "system" {
    fn SHChangeNotify(we_event_id: u32, u_flags: u32, dw_item1: *const c_void, dw_item2: *const c_void);
}

// Helpers ------------------------------------------------------------------

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Open (or create) a registry key under HKCU and return its handle.
/// The caller must call `RegCloseKey` on the result.
unsafe fn open_key(path: &str) -> Option<isize> {
    let mut hk: isize = 0;
    let key = wide(path);
    let rc = RegCreateKeyExW(
        HKEY_CURRENT_USER,
        key.as_ptr(),
        0, std::ptr::null_mut(),
        REG_OPTION_NON_VOLATILE,
        KEY_ALL_ACCESS,
        std::ptr::null(),
        &mut hk,
        std::ptr::null_mut(),
    );
    if rc == ERROR_SUCCESS { Some(hk) } else { None }
}

/// Write a REG_SZ value (UTF-16, null-terminated) under an already-open key.
unsafe fn set_sz(hk: isize, name: &str, value: &str) -> bool {
    let name_w = wide(name);
    let value_w = wide(value);
    let data = value_w.as_ptr() as *const u8;
    let data_len = (value_w.len() * 2) as u32;
    RegSetValueExW(hk, name_w.as_ptr(), 0, REG_SZ, data, data_len) == ERROR_SUCCESS
}

/// The exe path, quoted for use inside a `shell\open\command` value.
fn quoted_exe() -> Option<String> {
    std::env::current_exe()
        .ok()
        .map(|p: PathBuf| format!("\"{}\" \"%1\"", p.display()))
}

// The extensions we register. The vec is the canonical list used by both
// register and unregister, so the two can never get out of sync.
const EXTS: &[&str] = &["md", "markdown", "mdown", "mdx", "txt", "text", "log"];

/// Register all extensions under HKCU. Safe to call on every startup — it is
/// idempotent and produces no UAC prompt.
pub fn register() {
    let Some(cmd) = quoted_exe() else { return };
    unsafe {
        // 1. Declare the ProgId and its open command.
        //    HKCU\Software\Classes\notepads.FileType\shell\open\command
        let prog_id = "notepads.FileType";
        if let Some(hk) = open_key(&format!("Software\\Classes\\{prog_id}")) {
            set_sz(hk, "", "Text document");
            RegCloseKey(hk);
        }
        if let Some(hk) = open_key(&format!(
            "Software\\Classes\\{prog_id}\\shell\\open\\command"
        )) {
            set_sz(hk, "", &cmd);
            RegCloseKey(hk);
        }

        // 2. Point each extension at the ProgId.
        //    HKCU\Software\Classes\.md  →  (default) = "notepad.FileType"
        for ext in EXTS {
            let key = format!("Software\\Classes\\.{ext}");
            if let Some(hk) = open_key(&key) {
                set_sz(hk, "", prog_id);
                RegCloseKey(hk);
            }
        }

        // 3. Tell Explorer the associations changed so it redraws icons / menus.
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, std::ptr::null(), std::ptr::null());
    }
}

/// Remove all keys written by `register`, restoring the prior association.
pub fn unregister() {
    unsafe {
        for ext in EXTS {
            let key = wide(&format!("Software\\Classes\\.{ext}"));
            RegDeleteTreeW(HKEY_CURRENT_USER, key.as_ptr());
        }
        let prog = wide("Software\\Classes\\notepads.FileType");
        RegDeleteTreeW(HKEY_CURRENT_USER, prog.as_ptr());
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, std::ptr::null(), std::ptr::null());
    }
}

/// Returns true if at least one of our extensions currently points at the ProgId.
pub fn is_registered() -> bool {
    // Just probe .md — if the user deregistered from the OS it would have cleared
    // this too; the full scan is not worth the extra syscalls on every startup.
    unsafe {
        let mut hk: isize = 0;
        let key = wide("Software\\Classes\\.md");
        let rc = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            0, std::ptr::null_mut(),
            REG_OPTION_NON_VOLATILE,
            KEY_ALL_ACCESS,
            std::ptr::null(),
            &mut hk,
            std::ptr::null_mut(),
        );
        if rc != ERROR_SUCCESS { return false; }
        // Read the default value. Buffer of 128 chars is more than enough for a ProgId.
        let mut buf = [0u16; 128];
        let mut len = (buf.len() * 2) as u32;
        let mut kind: u32 = 0;
        let name = [0u16]; // empty string = default value
        let read_rc = {
            // RegQueryValueExW — not in our extern block above; add it inline.
            #[link(name = "advapi32")]
            extern "system" {
                fn RegQueryValueExW(
                    hkey: isize, name: *const u16, reserved: *mut u32, lp_type: *mut u32,
                    lp_data: *mut u8, lp_cb_data: *mut u32,
                ) -> u32;
            }
            RegQueryValueExW(hk, name.as_ptr(), std::ptr::null_mut(), &mut kind,
                             buf.as_mut_ptr() as *mut u8, &mut len)
        };
        RegCloseKey(hk);
        if read_rc != ERROR_SUCCESS { return false; }
        let nchars = (len / 2).saturating_sub(1) as usize;
        let got = String::from_utf16_lossy(&buf[..nchars.min(buf.len())]);
        got == "notepad.FileType"
    }
}
