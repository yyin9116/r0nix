use std::env;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    if !src.exists() {
        return Ok(());
    }

    fs::create_dir_all(dst)?;

    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            if let Some(parent) = dst_path.parent() {
                fs::create_dir_all(parent)?;
            }
            if let Err(err) = fs::copy(&src_path, &dst_path) {
                if err.kind() != io::ErrorKind::PermissionDenied {
                    return Err(err);
                }
            }
        }
    }

    Ok(())
}

fn copy_python_runtime() -> io::Result<()> {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let runtime_src = manifest_dir.join("runtime");
    if !runtime_src.exists() {
        return Ok(());
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap_or_default());
    let profile_dir = out_dir
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "failed to resolve profile dir"))?;

    let runtime_dst = profile_dir.join("runtime");
    copy_dir_recursive(&runtime_src, &runtime_dst)?;

    for entry in fs::read_dir(&runtime_src)? {
        let entry = entry?;
        let src = entry.path();
        if src.is_file() && src.extension().map(|ext| ext == "dll").unwrap_or(false) {
            let dst = profile_dir.join(entry.file_name());
            if let Err(err) = fs::copy(src, dst) {
                if err.kind() != io::ErrorKind::PermissionDenied {
                    return Err(err);
                }
            }
        }
    }

    Ok(())
}

fn main() {
    println!("cargo:rerun-if-changed=runtime");
    tauri_build::build();

    if let Err(err) = copy_python_runtime() {
        println!("cargo:warning=failed to copy python runtime assets: {err}");
    }
}
