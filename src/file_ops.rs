use rfd::FileDialog;
use std::fs;

/// Encoding tag shared with the frontend. Kept as a plain `&str` on the wire
/// (`utf8` / `utf8bom` / `utf16le` / `gbk`) so JS can store it in a tab and hand
/// it back on save without a translation table on either side.
pub const UTF8: &str = "utf8";
pub const UTF8_BOM: &str = "utf8bom";
pub const UTF16_LE: &str = "utf16le";
pub const GBK: &str = "gbk";

/// GBK, via the OS conversion tables rather than a crate. `encoding_rs` would
/// pull in every legacy code page's table for the one we need, and the binary is
/// meant to stay small; `main.rs` and `fonts.rs` already talk to Win32 this way.
const CP_GBK: u32 = 936;
/// Makes an invalid byte sequence fail the call instead of yielding mojibake,
/// which is the only reason the fallback below is safe to attempt.
const MB_ERR_INVALID_CHARS: u32 = 0x0000_0008;

#[link(name = "kernel32")]
extern "system" {
    fn MultiByteToWideChar(
        code_page: u32,
        flags: u32,
        mb_str: *const u8,
        mb_len: i32,
        wide_str: *mut u16,
        wide_len: i32,
    ) -> i32;
    fn WideCharToMultiByte(
        code_page: u32,
        flags: u32,
        wide_str: *const u16,
        wide_len: i32,
        mb_str: *mut u8,
        mb_len: i32,
        default_char: *const u8,
        used_default: *mut i32,
    ) -> i32;
}

pub fn pick_open_file() -> Option<String> {
    FileDialog::new()
        .add_filter("Markdown 文件", &["md", "markdown", "txt"])
        .add_filter("所有文件", &["*"])
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

/// `format` is the configured default extension (`md` / `markdown` / `txt`); it
/// decides which filter the dialog opens on and what the suggested name ends in.
pub fn pick_save_file(format: &str) -> Option<String> {
    let ext = match format {
        "markdown" => "markdown",
        "txt" => "txt",
        _ => "md",
    };
    let label = if ext == "txt" { "纯文本文件" } else { "Markdown 文件" };
    FileDialog::new()
        // The configured format goes first: rfd opens on the first filter, so
        // this is what makes the setting actually change the dialog's default.
        .add_filter(label, &[ext])
        .add_filter("所有文件", &["*"])
        // Default filename stays ASCII on purpose — it lands on disk and often
        // ends up in git/URLs, where a CJK name is friction rather than polish.
        .set_file_name(&format!("untitled.{ext}"))
        .save_file()
        .map(|p| p.to_string_lossy().to_string())
}

/// Reads a text file, returning `(content, encoding_tag)`.
///
/// BOM-marked encodings are detected outright. A file with no BOM that is not
/// valid UTF-8 is then *decoded* as GBK — not guessed at from byte statistics.
/// The decode runs with `MB_ERR_INVALID_CHARS`, so it either succeeds on a real
/// GBK file or fails and the caller reports an honest error; it can never turn a
/// broken file into mojibake. Valid UTF-8 is never routed here, so this cannot
/// misread a UTF-8 document.
pub fn read_file(path: &str) -> Result<(String, &'static str), std::io::Error> {
    let bytes = fs::read(path)?;

    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let text = String::from_utf8(bytes[3..].to_vec())
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid utf-8"))?;
        return Ok((text, UTF8_BOM));
    }

    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Ok((decode_utf16le(&bytes[2..]), UTF16_LE));
    }

    // UTF-16 BE. Decoded so the file opens rather than erroring, but reported as
    // LE: we only ever write LE, and claiming BE would promise a round-trip that
    // the writer does not implement.
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let swapped: Vec<u8> = bytes[2..]
            .chunks_exact(2)
            .flat_map(|c| [c[1], c[0]])
            .collect();
        return Ok((decode_utf16le(&swapped), UTF16_LE));
    }

    match String::from_utf8(bytes) {
        Ok(text) => Ok((text, UTF8)),
        Err(e) => match decode_gbk(e.as_bytes()) {
            Some(text) => Ok((text, GBK)),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "invalid utf-8",
            )),
        },
    }
}

/// GBK bytes → `String`, or `None` if the bytes are not valid GBK.
fn decode_gbk(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return Some(String::new());
    }
    unsafe {
        let needed = MultiByteToWideChar(
            CP_GBK,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            bytes.len() as i32,
            std::ptr::null_mut(),
            0,
        );
        if needed <= 0 {
            return None;
        }
        let mut buf = vec![0u16; needed as usize];
        let written = MultiByteToWideChar(
            CP_GBK,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            bytes.len() as i32,
            buf.as_mut_ptr(),
            needed,
        );
        if written <= 0 {
            return None;
        }
        buf.truncate(written as usize);
        String::from_utf16(&buf).ok()
    }
}

/// `String` → GBK bytes, or `None` if anything in the text has no GBK form.
///
/// Returning `None` rather than substituting `?` matters: silently replacing the
/// emoji in someone's note with question marks is data loss that only shows up
/// after the file is already overwritten.
fn encode_gbk(text: &str) -> Option<Vec<u8>> {
    if text.is_empty() {
        return Some(Vec::new());
    }
    let wide: Vec<u16> = text.encode_utf16().collect();
    unsafe {
        let needed = WideCharToMultiByte(
            CP_GBK,
            0,
            wide.as_ptr(),
            wide.len() as i32,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            std::ptr::null_mut(),
        );
        if needed <= 0 {
            return None;
        }
        let mut buf = vec![0u8; needed as usize];
        // Non-zero afterwards means at least one character fell back to the
        // substitution char, i.e. the text does not fit in GBK.
        let mut used_default: i32 = 0;
        let written = WideCharToMultiByte(
            CP_GBK,
            0,
            wide.as_ptr(),
            wide.len() as i32,
            buf.as_mut_ptr(),
            needed,
            std::ptr::null(),
            &mut used_default,
        );
        if written <= 0 || used_default != 0 {
            return None;
        }
        buf.truncate(written as usize);
        Some(buf)
    }
}

fn decode_utf16le(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    // Lossy: an unpaired surrogate becomes U+FFFD rather than failing the open.
    String::from_utf16_lossy(&units)
}

pub fn write_file(path: &str, content: &str, encoding: &str) -> Result<(), std::io::Error> {
    let bytes: Vec<u8> = match encoding {
        UTF8_BOM => {
            let mut v = vec![0xEF, 0xBB, 0xBF];
            v.extend_from_slice(content.as_bytes());
            v
        }
        UTF16_LE => {
            let mut v = vec![0xFF, 0xFE];
            for unit in content.encode_utf16() {
                v.extend_from_slice(&unit.to_le_bytes());
            }
            v
        }
        GBK => encode_gbk(content).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "内容含有 GBK 无法表示的字符，请改用 UTF-8 保存",
            )
        })?,
        _ => content.as_bytes().to_vec(),
    };
    fs::write(path, bytes)
}

/// Normalises whatever the frontend sent into one of the known tags, so a stale
/// localStorage value cannot make a save fall through to something unexpected.
pub fn normalize_encoding(tag: Option<&str>) -> &'static str {
    match tag {
        Some(UTF8_BOM) => UTF8_BOM,
        Some(UTF16_LE) => UTF16_LE,
        Some(GBK) => GBK,
        _ => UTF8,
    }
}
