//! System font-family enumeration.
//!
//! GDI is declared by hand instead of switching on the `windows` crate's
//! `Win32_Graphics_Gdi` feature: that feature drags in a large amount of
//! bindings for what amounts to three calls, and `main.rs` already talks to
//! Win32 this way for the stdin handle probe.

use std::collections::BTreeMap;

const LF_FACESIZE: usize = 32;
const DEFAULT_CHARSET: u8 = 1;
const FIXED_PITCH: u8 = 1;
const FF_MODERN: u8 = 3 << 4;

/// Win32 `LOGFONTW`. The enumeration callback is actually handed an
/// `ENUMLOGFONTEXW`, which begins with this struct, so the extra trailing
/// fields are simply never read.
#[repr(C)]
#[derive(Clone, Copy)]
struct LogFontW {
    height: i32,
    width: i32,
    escapement: i32,
    orientation: i32,
    weight: i32,
    italic: u8,
    underline: u8,
    strike_out: u8,
    char_set: u8,
    out_precision: u8,
    clip_precision: u8,
    quality: u8,
    pitch_and_family: u8,
    face_name: [u16; LF_FACESIZE],
}

type FontEnumProc = unsafe extern "system" fn(*const LogFontW, *const u8, u32, isize) -> i32;

#[link(name = "gdi32")]
extern "system" {
    fn CreateCompatibleDC(hdc: isize) -> isize;
    fn DeleteDC(hdc: isize) -> i32;
    fn EnumFontFamiliesExW(
        hdc: isize,
        logfont: *const LogFontW,
        proc: FontEnumProc,
        lparam: isize,
        flags: u32,
    ) -> i32;
}

unsafe extern "system" fn collect(
    logfont: *const LogFontW,
    _metric: *const u8,
    _font_type: u32,
    lparam: isize,
) -> i32 {
    let found = &mut *(lparam as *mut BTreeMap<String, bool>);
    let lf = &*logfont;

    let len = lf
        .face_name
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(LF_FACESIZE);
    let name = String::from_utf16_lossy(&lf.face_name[..len]);

    // '@' prefixes the sideways duplicate of every CJK family. Keeping them
    // would double the length of the dropdown with entries nobody picks.
    if name.is_empty() || name.starts_with('@') {
        return 1;
    }

    let mono =
        lf.pitch_and_family & 0x03 == FIXED_PITCH || lf.pitch_and_family & 0xF0 == FF_MODERN;
    // A family is reported once per charset it covers, so OR the flag rather
    // than letting the last charset seen decide.
    *found.entry(name).or_insert(false) |= mono;
    1 // any non-zero value continues the enumeration
}

/// Every installed font family as `(name, is_monospace)`, deduplicated.
///
/// Names come back in the current UI language, which is why the frontend no
/// longer carries a table of Chinese aliases: on a Chinese Windows this
/// already yields 微软雅黑 rather than "Microsoft YaHei".
pub fn list_families() -> Vec<(String, bool)> {
    let mut found: BTreeMap<String, bool> = BTreeMap::new();
    unsafe {
        let hdc = CreateCompatibleDC(0);
        if hdc == 0 {
            return Vec::new();
        }
        let mut lf: LogFontW = std::mem::zeroed();
        // Empty face name + DEFAULT_CHARSET means "every family, every charset".
        lf.char_set = DEFAULT_CHARSET;
        let sink = &mut found as *mut BTreeMap<String, bool>;
        EnumFontFamiliesExW(hdc, &lf, collect, sink as isize, 0);
        DeleteDC(hdc);
    }
    found.into_iter().collect()
}
