use std::{fs, os::unix::fs::PermissionsExt, path::Path};

// Release builds require real staged sidecars. Tests and editors use inert placeholders only.
const NODE: &str = "binaries/node-aarch64-apple-darwin";
const TSNET: &str = "binaries/nootify-tsnet-aarch64-apple-darwin";
const SERVICE: &str = "resources/service";
const PLACEHOLDER: &[u8] = b"#!/bin/sh\n# Development placeholder written by build.rs.\necho 'Run npm run desktop:stage to build the bundled runtimes' >&2\nexit 127\n";

fn main() {
    println!("cargo:rerun-if-changed=../package.json");
    println!("cargo:rerun-if-changed={NODE}");
    println!("cargo:rerun-if-changed={TSNET}");
    println!("cargo:rerun-if-changed={SERVICE}");
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        if !staged(Path::new(NODE))
            || !staged(Path::new(TSNET))
            || !Path::new(SERVICE).join("dist/src/server.js").is_file()
        {
            println!("cargo::error=Release builds require Node.js, the embedded Tailscale client and the service: run npm run desktop:stage first");
            return;
        }
    } else {
        fs::create_dir_all("binaries").expect("create binaries/");
        for binary in [NODE, TSNET] {
            let path = Path::new(binary);
            if !path.exists() {
                fs::write(path, PLACEHOLDER).expect("write sidecar placeholder");
                fs::set_permissions(path, fs::Permissions::from_mode(0o755))
                    .expect("chmod placeholder");
            }
        }
        fs::create_dir_all(SERVICE).expect("create resources/service/");
    }
    tauri_build::build();
}

fn staged(path: &Path) -> bool {
    // Real Mach-O sidecars are much larger than either generation of development placeholder.
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() > 4096)
}
