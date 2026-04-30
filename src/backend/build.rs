use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR missing"));
    let frontend_dir = manifest_dir.join("../frontend");
    let skills_dir = manifest_dir.join("../../skills");
    let extensions_dir = manifest_dir.join("../../extensions");

    println!(
        "cargo:rerun-if-changed={}",
        frontend_dir.join("index.html").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        frontend_dir.join("package.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        frontend_dir.join("vite.config.ts").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        frontend_dir.join("src").display()
    );
    println!("cargo:rerun-if-changed={}", skills_dir.display());
    println!("cargo:rerun-if-changed={}", extensions_dir.display());

    let prompts_path = manifest_dir.join("prompts/prompt-catalog.json");
    println!("cargo:rerun-if-changed={}", prompts_path.display());

    let status = Command::new("bun")
        .args(["run", "build"])
        .current_dir(&frontend_dir)
        .status()
        .unwrap_or_else(|error| {
            panic!(
                "failed to launch Bun to build the Solid frontend for embedded-frontend packaging: {}",
                error
            )
        });

    if !status.success() {
        panic!("Solid frontend build failed while preparing the embedded-frontend Rust binary");
    }
}
