use rfd::FileDialog;
use std::fs;
pub fn pick_open_file() -> Option<String> {
    FileDialog::new()
        .add_filter("Markdown 文件", &["md", "markdown", "txt"])
        .add_filter("所有文件", &["*"])
        .pick_file()
        .map(|p| p.to_string_lossy().to_string())
}

pub fn pick_save_file() -> Option<String> {
    FileDialog::new()
        .add_filter("Markdown 文件", &["md", "markdown"])
        .add_filter("所有文件", &["*"])
        // Default filename stays ASCII on purpose — it lands on disk and often
        // ends up in git/URLs, where a CJK name is friction rather than polish.
        .set_file_name("untitled.md")
        .save_file()
        .map(|p| p.to_string_lossy().to_string())
}

pub fn read_file(path: &str) -> Result<String, std::io::Error> {
    fs::read_to_string(path)
}

pub fn write_file(path: &str, content: &str) -> Result<(), std::io::Error> {
    fs::write(path, content)
}
