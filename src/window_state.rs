use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// Geometry is stored in **physical** pixels throughout.
///
/// `inner_size()` and `outer_position()` hand back physical values, so restoring
/// them through `LogicalSize`/`LogicalPosition` re-multiplied them by the scale
/// factor: on a 150% display the window grew by half on every launch, which is
/// why it never looked like the size had been remembered.
#[derive(Serialize, Deserialize, Clone, Copy)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// Absent in files written by older builds, hence the default.
    #[serde(default)]
    pub maximized: bool,
}

const DEFAULT: WindowState = WindowState {
    x: 100,
    y: 100,
    width: 900,
    height: 700,
    maximized: false,
};

const MIN_W: u32 = 420;
const MIN_H: u32 = 320;

fn config_path() -> PathBuf {
    let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("peekdown");
    p.push("window_state.json");
    p
}

pub fn load_window_state() -> WindowState {
    let path = config_path();
    if let Ok(data) = fs::read_to_string(&path) {
        if let Ok(state) = serde_json::from_str::<WindowState>(&data) {
            return state;
        }
    }
    DEFAULT
}

/// Keeps a restored window reachable. A monitor that was unplugged (or a
/// resolution change) can leave the saved rectangle entirely off-screen, and a
/// borderless window there is unrecoverable — no titlebar to drag it back with.
/// `monitors` is a slice of `(x, y, width, height)` in physical pixels.
pub fn fit_to_monitors(state: WindowState, monitors: &[(i32, i32, u32, u32)]) -> WindowState {
    let mut st = state;
    st.width = st.width.max(MIN_W);
    st.height = st.height.max(MIN_H);
    if monitors.is_empty() {
        return st;
    }

    // Demand a usable chunk of the titlebar on some monitor, not one stray pixel.
    let reachable = monitors.iter().any(|&(mx, my, mw, mh)| {
        let overlap_w = (st.x + st.width as i32).min(mx + mw as i32) - st.x.max(mx);
        let overlap_h = (st.y + st.height as i32).min(my + mh as i32) - st.y.max(my);
        overlap_w >= 120 && overlap_h >= 40
    });
    if !reachable {
        st.x = DEFAULT.x;
        st.y = DEFAULT.y;
    }
    st
}

/// `pos`/`size` are the last **non-maximized** geometry, so unmaximizing after a
/// restart lands the window back where it was rather than filling the screen.
pub fn save_window_state(pos: (i32, i32), size: (u32, u32), maximized: bool) {
    let state = WindowState {
        x: pos.0,
        y: pos.1,
        width: size.0,
        height: size.1,
        maximized,
    };
    let path = config_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, serde_json::to_string(&state).unwrap_or_default());
}
