#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import shutil
import site
import sys
import sysconfig
import zipfile
from pathlib import Path


def copy_file(src: Path, dst: Path) -> None:
    if not src.exists():
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def copy_tree(src: Path, dst: Path) -> None:
    if not src.exists():
        raise FileNotFoundError(f"missing source path: {src}")
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def cleanup_tree(root: Path) -> None:
    if not root.exists():
        return
    for cache_dir in root.rglob("__pycache__"):
        shutil.rmtree(cache_dir, ignore_errors=True)


def find_site_packages() -> Path:
    candidates = []
    for p in site.getsitepackages():
        path = Path(p)
        if path.exists():
            candidates.append(path)
    user_site = Path(site.getusersitepackages())
    if user_site.exists():
        candidates.append(user_site)
    if not candidates:
        raise RuntimeError("cannot locate site-packages")
    return candidates[0]


def prepare_runtime(runtime_dir: Path) -> None:
    runtime_dir.mkdir(parents=True, exist_ok=True)
    site_packages_dst = runtime_dir / "site-packages"
    site_packages_dst.mkdir(parents=True, exist_ok=True)

    python_home = Path(sys.base_prefix)
    stdlib = Path(sysconfig.get_path("stdlib"))
    py_ver = f"{sys.version_info.major}{sys.version_info.minor}"
    zip_name = f"python{py_ver}.zip"
    zip_path = runtime_dir / zip_name

    for dll_name in (f"python{py_ver}.dll", "python3.dll"):
        copy_file(python_home / dll_name, runtime_dir / dll_name)

    extra_win_dlls = [
        "zlib.dll",
        "libssl-3-x64.dll",
        "libcrypto-3-x64.dll",
        "sqlite3.dll",
        "bz2.dll",
        "lzma.dll",
        "libffi-8.dll",
    ]
    for dll_name in extra_win_dlls:
        copy_file(python_home / dll_name, runtime_dir / dll_name)

    libdir = Path(sysconfig.get_config_var("LIBDIR") or "")
    libpython = f"libpython{sys.version_info.major}.{sys.version_info.minor}.dylib"
    copy_file(libdir / libpython, runtime_dir / libpython)
    copy_file(python_home / "lib" / libpython, runtime_dir / libpython)

    if zip_path.exists():
        zip_path.unlink()

    exclude_prefixes = {
        stdlib / "site-packages",
        stdlib / "test",
        stdlib / "tkinter",
        stdlib / "ensurepip",
        stdlib / "idlelib",
    }
    allowed_suffixes = {
        ".py",
        ".pyi",
        ".txt",
        ".cfg",
        ".ini",
        ".json",
        ".xml",
        ".dat",
        ".pem",
        ".crt",
        ".pth",
    }

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as zf:
        for root, dirs, files in os.walk(stdlib):
            root_path = Path(root)
            if any(root_path == p or str(root_path).startswith(str(p) + os.sep) for p in exclude_prefixes):
                dirs[:] = []
                continue
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for file_name in files:
                src_file = root_path / file_name
                if src_file.suffix.lower() in allowed_suffixes:
                    arcname = src_file.relative_to(stdlib).as_posix()
                    zf.write(src_file, arcname)

    import fitz  # noqa: WPS433
    import pymupdf  # noqa: WPS433

    fitz_src = Path(fitz.__file__).resolve().parent
    pymupdf_src = Path(pymupdf.__file__).resolve().parent
    copy_tree(fitz_src, site_packages_dst / "fitz")
    copy_tree(pymupdf_src, site_packages_dst / "pymupdf")
    cleanup_tree(site_packages_dst / "fitz")
    cleanup_tree(site_packages_dst / "pymupdf")

    pymupdf_devel = site_packages_dst / "pymupdf" / "mupdf-devel"
    if pymupdf_devel.exists():
        shutil.rmtree(pymupdf_devel, ignore_errors=True)

    print(f"[prepare-runtime] python: {Path(sys.executable)}")
    print(f"[prepare-runtime] home: {python_home}")
    print(f"[prepare-runtime] stdlib zip: {zip_path} ({zip_path.stat().st_size} bytes)")
    print(f"[prepare-runtime] fitz from: {fitz_src}")
    print(f"[prepare-runtime] pymupdf from: {pymupdf_src}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare embedded Python runtime for Tauri bundles")
    parser.add_argument(
        "--runtime-dir",
        default="src-tauri/runtime",
        help="Destination runtime directory",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    runtime_dir = Path(args.runtime_dir).resolve()
    prepare_runtime(runtime_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
