use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf, process::Command};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=assets/agent.js");
    let target = env::var("TARGET")?;
    let (arch, digest) = match target.as_str() {
        "aarch64-apple-darwin" => (
            "arm64",
            "4dddc5d3a8febb72b64e779ba4e7c953a219fce8f9392f4decac957261475f87",
        ),
        "x86_64-apple-darwin" => (
            "x86_64",
            "8417da3238ca989dcefce6ed3011cb4723103b85b2d98ff124c4fea07d40d539",
        ),
        _ => return Err("This daemon currently targets macOS".into()),
    };
    let out = PathBuf::from(env::var("OUT_DIR")?);
    let kit = out.join("frida-17.22.2");
    if !kit.join(".complete").exists() {
        let staging = out.join("frida-extracting");
        if staging.exists() {
            fs::remove_dir_all(&staging)?;
        }
        fs::create_dir(&staging)?;
        let archive = out.join("frida-devkit.tar.xz");
        let url = format!(
            "https://github.com/frida/frida/releases/download/17.22.2/frida-core-devkit-17.22.2-macos-{arch}.tar.xz"
        );
        if !Command::new("/usr/bin/curl")
            .args([
                "--fail",
                "--silent",
                "--show-error",
                "--location",
                "--retry",
                "3",
                "--connect-timeout",
                "15",
                "--max-time",
                "180",
                "-o",
            ])
            .arg(&archive)
            .arg(url)
            .status()?
            .success()
        {
            return Err("Frida devkit download failed".into());
        }
        let actual = format!("{:x}", Sha256::digest(fs::read(&archive)?));
        if actual != digest {
            return Err("Frida devkit checksum mismatch".into());
        }
        if !Command::new("/usr/bin/tar")
            .arg("-xf")
            .arg(&archive)
            .arg("-C")
            .arg(&staging)
            .status()?
            .success()
        {
            return Err("Frida devkit extraction failed".into());
        }
        for file in ["frida-core.h", "libfrida-core.a"] {
            if !fs::metadata(staging.join(file))?.is_file() {
                return Err("Frida devkit missing required file".into());
            }
        }
        fs::write(staging.join(".complete"), digest)?;
        if kit.exists() {
            fs::remove_dir_all(&kit)?;
        }
        fs::rename(staging, &kit)?;
        fs::remove_file(archive)?;
    }
    let bindings = bindgen::Builder::default()
        .header(kit.join("frida-core.h").to_string_lossy())
        .allowlist_function("frida_(init|deinit|unref|version_string|device_manager_new|device_manager_get_device_by_id_sync|device_manager_close_sync|device_attach_sync|session_create_script_sync|session_detach_sync|script_load_sync|script_unload_sync|script_post|script_options_new|script_options_set_runtime)")
        .allowlist_function("g_(error_free|signal_connect_data|signal_handler_disconnect)")
        .allowlist_type("FridaScriptRuntime")
        .generate_comments(false).layout_tests(false).derive_debug(false)
        .generate()?;
    bindings.write_to_file(out.join("frida.rs"))?;
    println!("cargo:rustc-link-search=native={}", kit.display());
    println!("cargo:rustc-link-lib=static=frida-core");
    for lib in ["bsm", "resolv", "pthread", "dl", "m"] {
        println!("cargo:rustc-link-lib={lib}");
    }
    for framework in [
        "Foundation",
        "CoreFoundation",
        "AppKit",
        "CoreServices",
        "Security",
        "IOKit",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    Ok(())
}
