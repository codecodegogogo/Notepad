use rfd::FileDialog;
use std::fs;

/// Encoding tag shared with the frontend. Kept as a plain `&str` on the wire
/// (`utf8` / `utf8bom` / `utf16le`) so JS can store it in a tab and hand it back
/// on save without a translation table on either side.
pub const UTF8: &str = "utf8";
pub const UTF8_BOM: &str = "utf8bom";
pub const UTF16_LE: &str = "utf16le";

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
/// Only BOM-marked encodings are detected. Guessing at a legacy code page from
/// byte statistics is the kind of heuristic that silently mangles a file, and a
/// non-UTF-8 file without a BOM already gets an honest error from the caller.
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

    let text = String::from_utf8(bytes)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid utf-8"))?;
    Ok((text, UTF8))
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
        _ => content.as_bytes().to_vec(),
    };
    fs::write(path, bytes)
}

/// Normalises whatever the frontend sent into one of the three tags, so a stale
/// localStorage value cannot make a save fall through to something unexpected.
pub fn normalize_encoding(tag: Option<&str>) -> &'static str {
    match tag {
        Some(UTF8_BOM) => UTF8_BOM,
        Some(UTF16_LE) => UTF16_LE,
        _ => UTF8,
    }
}
