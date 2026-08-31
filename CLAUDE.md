# Peekdown — Markdown Viewer/Editor

## What is this?
A lightweight native Windows markdown viewer/editor built with Rust + WebView2.
Goal: Notepad-fast startup, Obsidian-pretty UI. Single ~800 KB executable.

## Tech Stack
- Rust backend (wry + tao) for window management, file I/O, drag & drop
- HTML/CSS/JS frontend embedded in the binary for UI rendering
- marked.js for markdown → HTML conversion
- highlight.js for syntax highlighting (30+ languages)
- WebView2 (Edge) as the rendering engine (pre-installed on Win10/11)

## Build
```bash
cargo build --release
```
Binary output: `target/release/peekdown.exe`

`build.rs` uses `winresource` to embed `assets/notebook.ico` into the .exe.

## Project Layout
- `src/main.rs` — Entry point, window + WebView setup, event loop, HTML assembly
- `src/ipc.rs` — IPC message dispatch between Rust and JS
- `src/file_ops.rs` — File read/write with BOM + GBK encoding detection, native open/save dialogs (rfd)
- `src/fonts.rs` — System font-family enumeration via hand-declared GDI `EnumFontFamiliesExW`
- `src/state.rs` — App state: pending file/stdin payloads, assembled HTML, live non-maximized window geometry (JS owns all tab state)
- `src/window_state.rs` — Window geometry + maximized-state persistence (config dir: `peekdown/`)
- `build.rs` — Embeds app icon via winresource
- `assets/notebook.ico` — App icon (48px; CI upsizes it to the smaller Windows shell sizes)
- `src/frontend/` — All HTML/CSS/JS files (embedded at compile time via include_str!)
  - `index.html` — Shell with titlebar, tab bar, find bar, TOC panel, editor, preview, settings panel
  - `style.css` — Full styling with dark/light theme via CSS custom properties
  - `app.js` — IPC bridge, mode toggle, split view, zoom, find, recent files, TOC, shortcuts
  - `tabs.js` — Tab manager IIFE (JS-owned state: content, path, dirty, mode, scroll, cursor)
  - `editor.js` — Textarea input handling, tab key, dirty tracking, split preview sync
  - `preview.js` — marked.js custom renderer with highlight.js integration
  - `settings.js` — Settings panel IIFE: theme (3-state), the three font slots + sizes, persistence
  - `marked.min.js` — Markdown parser (v15)
  - `highlight.min.js` — Syntax highlighting (v11.11.1, common bundle)

## Architecture
- IPC: JS → Rust via `window.ipc.postMessage(JSON)`, Rust → JS via `webview.evaluate_script()`
- Frontend files are concatenated into a single HTML document at compile time using placeholder replacement
- JS-owned tab state: Rust is a stateless file I/O service, JS manages all tab data
- Script load order: highlight.js → marked.js → preview.js → tabs.js → editor.js → app.js → settings.js
  (settings.js last: it touches the DOM and app.js globals at parse time)
- Toggle mode: single pane switches between edit (textarea) and preview (rendered HTML)
- Split mode: side-by-side editor + live preview with debounced sync
- Theming: CSS custom properties with `[data-theme="light"]` overrides. settings.js resolves
  `light | dark | system` (via `matchMedia`) onto `data-theme` at parse time, before first paint
- Font sizing: `--ui-scale` scales every chrome font-size and the bar heights (`--h-titlebar`,
  `--h-tabbar`, `--h-statusbar`); `--font-size-editor` / `--font-size-preview` size the two panes
  and multiply with `--zoom` so Ctrl+scroll stays independent of the settings value
- Window geometry is stored in **physical** pixels (`inner_size()` / `Moved` report physical;
  restoring through `LogicalSize` re-multiplied by the scale factor and grew the window each
  launch). `AppState` tracks the last non-maximized rectangle live, because a maximized window
  can only report its maximized bounds — that plus `maximized: bool` is what gets persisted
- Maximized state is pushed Rust → JS (`window.__setMaximized`) on `Resized`, on the
  `window_maximize` command and on `ready`. The titlebar is an `app-region: drag` surface, so
  Windows also maximizes on double-click / Win+Up / top-edge snap without JS hearing about it
- Drag & drop runs native-first: wry's drop target reports real paths (needed for in-place
  Ctrl+S). app.js mirrors the HTML5 drag events, `preventDefault`s them (Chromium otherwise
  navigates to `file://`) and only falls back to `FileReader` if no `file_opened` arrives within
  400 ms — so exactly one document opens no matter which layer won the drag
- Font pickers list the **real installed families**: `fonts.rs` enumerates them through GDI
  (`EnumFontFamiliesExW`, `@`-prefixed vertical CJK duplicates skipped) and `ipc.rs` answers the
  `list_fonts` command with `window.__setFonts`. Requested lazily on the first settings open, so
  startup does not pay for it. Names come back already localised, so no alias table is needed.
  Each `<option>` is rendered in the family it names; the editor slot puts monospace in a leading
  `<optgroup>`. `color-scheme` on `:root` is what makes Chromium's native dropdown legible in the
  dark theme
- Tab strip follows Notepad: tabs bottom-align in the bar with only their top corners rounded,
  and the active tab is filled with `--bg-base` so it runs into the page. `#tab-bar` therefore
  carries no `border-bottom`, and `.has-tabs #titlebar` drops its own so the chrome reads as one
  block
- Titlebar buttons are declared once, in `app.js`'s `TOOLBAR_BUTTONS`: the loop below it injects a
  `.btn-label` into each button, and `settings.js` reads the same array to build the visibility
  checkboxes, so the settings list cannot drift from the bar. Display mode is a
  `body[data-toolbar-display]` attribute (`icon` / `text` / `both`) — CSS does the switching, no
  DOM rebuild. Hiding a button is `style.display`. There are no group separators: one uniform gap
  runs between every button, so hiding one cannot strand a divider
- `window.confirm()` is not used. WebView2 renders it as a Chromium page dialog pinned to the top
  edge of the viewport, overlapping our own titlebar, unthemeable and unmovable. `askConfirm(msg,
  onOk)` in app.js draws `#confirm-overlay` instead and answers through a callback — which is why
  `TabManager.closeTab` splits into `closeTab` (asks) and `removeTab` (acts, re-resolving the index
  because the list can shift while the dialog is up). Its Esc/Enter handler is registered in the
  capture phase so it outranks the find bar's Escape
- Encoding: BOMs are detected outright, then a BOM-less file that fails UTF-8 validation is
  *decoded* as GBK through Win32 `MultiByteToWideChar` (CP 936) — not guessed at from byte
  statistics. `MB_ERR_INVALID_CHARS` makes that decode all-or-nothing, so it can only ever succeed
  on a real GBK file or fall through to an honest error; valid UTF-8 never reaches it. Writing GBK
  goes back through `WideCharToMultiByte`, and a non-zero `lpUsedDefaultChar` aborts the save
  rather than replacing an emoji with `?` in a file that is about to be overwritten. The OS tables
  are used instead of `encoding_rs` because that crate carries every legacy code page for the one
  we need. `file_ops::read_file` returns `(String, &'static str)` tagged
  `utf8` / `utf8bom` / `utf16le` / `gbk`. UTF-16 BE opens (byte-swapped) but reports as LE, since
  LE is all the writer emits. JS parks the tag on the tab, so Ctrl+S rewrites a file in the
  encoding it arrived in; only a fresh buffer takes the configured default
- The titlebar shows no filename — it is a bare drag spacer (`#titlebar-spacer`). The name lives in
  the tab, the status bar and the OS window title (`set_title`, for taskbar / Alt+Tab)
- `__VERSION__` in index.html is replaced with `CARGO_PKG_VERSION` at compile time

## Features
- Chinese UI throughout (tooltips, status bar, dialogs, empty states)
- Settings panel (Ctrl+,) in the Win11-Notepad style — accordion cards, gear button leftmost in the
  titlebar action group
- Themes: Day / Night / Follow system (Win11-Notepad light / Catppuccin-Mocha dark)
- Configurable font family + size for all three slots (UI chrome, editor, reading), choosing from
  every font installed on the system — one 字体 card holding all three
- Customisable titlebar: pick which buttons show, and whether they show icon / text / both
- Default character encoding (UTF-8 / UTF-8 BOM / UTF-16 LE / GBK) + default file format for new
  files (设置 → 文本格式 → 保存格式); GBK files also open without a BOM
- 另存为 button in the titlebar (Ctrl+Shift+S)
- Status bar right cluster: word count, live zoom percentage, current file encoding
- Multi-tab with auto-hiding tab bar (single tab = no bar) and a trailing `+` button
- Window position, size and maximized state are restored on next launch
- Maximize button swaps to a restore glyph while maximized
- Split view (Ctrl+\) with live preview
- Syntax highlighting for code blocks
- Find bar (Ctrl+F) with match highlighting
- Table of Contents sidebar (Ctrl+Shift+O)
- Zoom (Ctrl+/-, Ctrl+scroll) with toast indicator
- Draggable preview width
- Recent files panel on empty tabs
- Cross-mode selection preservation when toggling edit/preview
- Drag & drop (single and multi-file, any text file — folders are rejected with a message)
- File associations via CLI arg

## Conventions
- Keep the binary small: use `opt-level = "s"`, `lto = "fat"`, `panic = "abort"`, `strip = "none"` (never strip symbols — needed for crash diagnostics)
- No external runtime dependencies — everything embedded in the .exe
- Dark theme is Catppuccin-Mocha-inspired; light theme is Windows 11 Notepad's Fluent palette
  (`#ffffff` page, `#f3f3f3` chrome, `#e5e5e5` dividers, `#005fb8` accent). The two stack their
  surfaces in **opposite directions** — dark lifts a card above the page, light drops the page
  below a white card — so settings surfaces use `--bg-card` / `--bg-sunken` rather than reusing
  `--bg-base` / `--bg-surface`
- JS uses IIFE pattern for modules (TabManager, Settings)
- localStorage keys prefixed with `peekdown-` (theme, recent, preview-width,
  font-ui/editor/reading, size-ui/editor/reading, encoding, format, toolbar-display,
  toolbar-shown). `toolbar-shown` is a JSON map and is read as "absent means visible", so a
  button added in a later version does not vanish for existing users
- User-facing strings are Chinese; `eprintln!` logs and on-disk defaults (e.g. `untitled.md`) stay ASCII
