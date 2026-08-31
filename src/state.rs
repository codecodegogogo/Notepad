pub struct AppState {
    pub html: String,
    pub pending_file: Option<String>,
    pub pending_content: Option<String>,
    pub pending_title: Option<String>,
    /// Last geometry seen while the window was *not* maximized, in physical
    /// pixels. Tracked live because a maximized window can only report its
    /// maximized bounds, and that is not what we want to restore to.
    pub normal_pos: (i32, i32),
    pub normal_size: (u32, u32),
}

impl AppState {
    pub fn new() -> Self {
        Self {
            html: String::new(),
            pending_file: None,
            pending_content: None,
            pending_title: None,
            normal_pos: (100, 100),
            normal_size: (900, 700),
        }
    }
}
