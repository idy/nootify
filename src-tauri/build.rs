#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{fs, path::Path};

const SERVICE: &str = "resources/service";
const PLACEHOLDER: &[u8] =
    b"Development placeholder: run npm run desktop:stage to build the bundled runtimes.\n";

fn main() {
    let target = std::env::var("TARGET").expect("Cargo target triple");
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let node = format!("binaries/node-{target}{extension}");
    let tsnet = format!("binaries/nootify-tsnet-{target}{extension}");
    println!("cargo:rerun-if-changed=../package.json");
    for binary in [&node, &tsnet] {
        println!("cargo:rerun-if-changed={binary}");
    }
    println!("cargo:rerun-if-changed={SERVICE}");
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        if !staged(Path::new(&node))
            || !staged(Path::new(&tsnet))
            || !Path::new(SERVICE).join("dist/src/server.js").is_file()
            || (target.contains("windows")
                && [
                    "service.ps1",
                    "service-runner.cs",
                    "inbox-auth.ps1",
                    "inbox-auth.cs",
                ]
                .iter()
                .any(|name| !Path::new(SERVICE).join("windows").join(name).is_file()))
        {
            println!("cargo::error=Release builds require Node.js, the embedded Tailscale client and the service: run npm run desktop:stage first");
            return;
        }
    } else {
        // Inert placeholders let tests and editors compile without downloaded runtimes.
        fs::create_dir_all("binaries").expect("create binaries/");
        for binary in [&node, &tsnet] {
            let path = Path::new(binary);
            if !path.exists() {
                fs::write(path, PLACEHOLDER).expect("write sidecar placeholder");
                #[cfg(unix)]
                fs::set_permissions(path, fs::Permissions::from_mode(0o755))
                    .expect("chmod placeholder");
            }
        }
        fs::create_dir_all(SERVICE).expect("create resources/service/");
    }
    tauri_build::build();
}

fn staged(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() > 4096)
}
