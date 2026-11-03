use std::{fs, os::unix::fs::PermissionsExt, path::Path};

// tauri-build copies `bundle.externalBin` and `bundle.resources` while compiling and fails when they
// are missing. scripts/stage-service.mjs stages the real Node.js runtime and service, and runs before
// every `tauri build`. Other debug builds (cargo test, clippy, editors) get inert placeholders here;
// release builds refuse them, so no bundle ships without its service.
const NODE: &str = "binaries/node-aarch64-apple-darwin";
const SERVICE: &str = "resources/service";
const PLACEHOLDER: &[u8] = b"#!/bin/sh\n# Development placeholder written by build.rs.\necho 'This build has no bundled Node.js runtime; run node scripts/stage-service.mjs' >&2\nexit 127\n";

fn main() {
    // tauri.conf.json takes its version from package.json.
    println!("cargo:rerun-if-changed=../package.json");
    println!("cargo:rerun-if-changed={NODE}");
    println!("cargo:rerun-if-changed={SERVICE}");
    let node = Path::new(NODE);
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        if !staged(node) || !Path::new(SERVICE).join("dist/src/server.js").is_file() {
            println!("cargo::error=Release builds bundle the service: run `npm run build && node scripts/stage-service.mjs` first (tauri build runs it as beforeBuildCommand)");
            return;
        }
    } else {
        if !node.exists() {
            fs::create_dir_all("binaries").expect("create binaries/");
            fs::write(node, PLACEHOLDER).expect("write the Node.js placeholder");
            fs::set_permissions(node, fs::Permissions::from_mode(0o755))
                .expect("chmod placeholder");
        }
        fs::create_dir_all(SERVICE).expect("create resources/service/");
    }
    tauri_build::build();
}

/// Whether the real runtime is present: not missing, and not the (tiny) placeholder.
fn staged(node: &Path) -> bool {
    match fs::metadata(node) {
        Ok(meta) if meta.len() == PLACEHOLDER.len() as u64 => {
            fs::read(node).is_ok_and(|b| b != PLACEHOLDER)
        }
        Ok(meta) => meta.is_file(),
        Err(_) => false,
    }
}
