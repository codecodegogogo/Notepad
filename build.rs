fn main() {
    let mut res = winresource::WindowsResource::new();
    res.set_icon("assets/notebook.ico");
    res.compile().unwrap();
}
