// Generates `manifest_generated.rs` from the sibling `manifest.toml`
// (one level up from this Cargo crate) plus optional `templates/`.
fn main() {
    let crate_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let package_root = crate_dir.parent().expect("backend/ has a parent");
    manifest_build::generate_manifest(package_root);
}
