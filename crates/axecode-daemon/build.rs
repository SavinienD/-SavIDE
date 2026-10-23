fn main() {
    // axe:webui — re-embed the web app when `web/dist` changes.
    println!("cargo:rerun-if-changed=../../web/dist");
}
