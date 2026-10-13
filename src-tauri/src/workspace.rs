//! 应用本地工作区 —— 所有持久化数据的唯一根目录。
//!
//! # 为什么不再用系统钥匙串
//!
//! macOS Keychain 对**每次**读取都会弹授权框要求输密码。API Key 每次启动都要读，
//! 于是变成「打开软件先输一次密码」。这是不可接受的产品体验，因此密钥改为
//! 工作区内的 `config/secrets.json`（用户目录权限 0700、文件权限 0600）。
//! 钥匙串只保留一条**用户主动点击**才会走的迁移通道（见 `migrate_keychain_secret`）。
//!
//! # 目录布局
//!
//! ```text
//! <root>/
//!   config/settings.json      应用设置
//!   config/secrets.json       API Key（0600）
//!   library/library.json      资料库文档索引
//!   documents/<docId>.pdf     导入进资料库的 PDF 副本
//!   assist-history/<docId>.json
//!   cache/                    派生缓存，可安全清空
//! ```
//!
//! 根目录指针 `workspace-root.json` 刻意放在 **app_data_dir 而不是工作区内部**：
//! 用户把工作区整个搬走或删掉时，指针仍然找得到，不会变成孤儿。

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 指针文件名：记录「当前工作区在哪」。
const POINTER_FILE: &str = "workspace-root.json";
/// 默认工作区目录名（app_data_dir 下）。
const DEFAULT_DIR_NAME: &str = "workspace";
/// 允许相对 key 使用的扩展名白名单。
const ALLOWED_EXTENSIONS: &[&str] = &["json", "pdf", "md", "markdown"];
/// 递归统计容量时的文件数上限：资料库理论上有上限，但没有理由为病态目录卡住设置页。
const MAX_SCAN_ENTRIES: usize = 50_000;

#[derive(Debug, Clone)]
pub struct WorkspaceLayout {
    pub root: PathBuf,
    pub config_dir: PathBuf,
    pub documents_dir: PathBuf,
    pub library_dir: PathBuf,
    pub history_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub is_custom: bool,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct WorkspacePointer {
    root: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUsage {
    pub file_count: usize,
    pub total_bytes: u64,
    /// 扫描触顶时为 true：面板需要如实告知「数字偏小」，而不是假装精确。
    pub truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub root: String,
    pub config_dir: String,
    pub documents_dir: String,
    pub library_dir: String,
    pub history_dir: String,
    pub cache_dir: String,
    pub is_custom: bool,
    pub usage: WorkspaceUsage,
}

// ---------------------------------------------------------------------------
// 路径解析与校验
// ---------------------------------------------------------------------------

fn pointer_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(POINTER_FILE)
}

fn read_pointer(app_data_dir: &Path) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(pointer_path(app_data_dir)).ok()?;
    let parsed: WorkspacePointer = serde_json::from_str(&raw).ok()?;
    let root = parsed.root?.trim().to_string();
    if root.is_empty() {
        return None;
    }
    let candidate = PathBuf::from(root);
    // 指针指向的目录已被删除 / 换成文件 → 视为没设置过，回落默认位置。
    candidate.is_dir().then_some(candidate)
}

fn write_pointer(app_data_dir: &Path, root: &Path) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir)
        .map_err(|err| format!("failed to create app data dir: {err}"))?;
    let payload = WorkspacePointer {
        root: Some(root.to_string_lossy().into_owned()),
    };
    let serialized = serde_json::to_string_pretty(&payload)
        .map_err(|err| format!("failed to serialize workspace pointer: {err}"))?;
    std::fs::write(pointer_path(app_data_dir), serialized)
        .map_err(|err| format!("failed to write workspace pointer: {err}"))
}

/// 解析当前工作区根目录并确保子目录存在。
///
/// 默认落在 `app_data_dir/workspace`：那里是用户自己的目录，不受 macOS TCC
/// 保护目录拦截，用户换存储位置也不需要重新授权。
pub fn ensure_layout(app_data_dir: &Path) -> Result<WorkspaceLayout, String> {
    let (root, is_custom) = match read_pointer(app_data_dir) {
        Some(custom) => (custom, true),
        None => (app_data_dir.join(DEFAULT_DIR_NAME), false),
    };
    let layout = WorkspaceLayout {
        config_dir: root.join("config"),
        documents_dir: root.join("documents"),
        library_dir: root.join("library"),
        history_dir: root.join("assist-history"),
        cache_dir: root.join("cache"),
        is_custom,
        root,
    };
    for dir in [
        &layout.root,
        &layout.config_dir,
        &layout.documents_dir,
        &layout.library_dir,
        &layout.history_dir,
        &layout.cache_dir,
    ] {
        std::fs::create_dir_all(dir)
            .map_err(|err| format!("failed to create workspace dir {}: {err}", dir.display()))?;
    }
    restrict_directory_permissions(&layout.root);
    restrict_directory_permissions(&layout.config_dir);
    Ok(layout)
}

pub fn default_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DEFAULT_DIR_NAME)
}

/// 相对 key → 绝对路径。
///
/// 允许多级（`assist-history/x.json`），但**逐段**校验：
/// - 绝对路径、空段、`.`、`..`、Windows 盘符一律拒绝；
/// - 段内不允许路径分隔符与 NUL（分隔符已被分段拆掉，这里防的是残留注入）；
/// - 扩展名走白名单，避免工作区被当成任意写落点。
///
/// ⚠️ 旧实现直接拒绝任何含 `/` 的 key，而 assistHistory 一直传
/// `assist-history/<id>.json` —— 于是文件通道每次都报错，历史静默退回
/// localStorage，重启即丢。这里逐段校验才是对的形态。
pub fn resolve_in(root: &Path, key: &str) -> Result<PathBuf, String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("workspace key is empty".to_string());
    }
    if trimmed.len() > 240 {
        return Err("workspace key is too long".to_string());
    }
    let normalized = trimmed.replace('\\', "/");
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return Err("workspace key must be relative".to_string());
    }

    let mut resolved = root.to_path_buf();
    let mut segments: Vec<&str> = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => {
                let text = segment
                    .to_str()
                    .ok_or_else(|| "workspace key contains non-UTF-8 segments".to_string())?;
                if text.starts_with('.') {
                    return Err("workspace key segments must not start with a dot".to_string());
                }
                if text.contains('\0') {
                    return Err("workspace key contains a null byte".to_string());
                }
                segments.push(text);
            }
            Component::CurDir => continue,
            Component::ParentDir => {
                return Err("workspace key must not traverse upwards".to_string())
            }
            _ => return Err("workspace key must be a plain relative path".to_string()),
        }
    }
    if segments.is_empty() {
        return Err("workspace key is empty".to_string());
    }
    if segments.len() > 4 {
        return Err("workspace key is nested too deeply".to_string());
    }

    let extension_ok = segments
        .last()
        .and_then(|last| last.rsplit_once('.'))
        .map(|(_, extension)| {
            ALLOWED_EXTENSIONS
                .iter()
                .any(|allowed| extension.eq_ignore_ascii_case(allowed))
        })
        .unwrap_or(false);
    if !extension_ok {
        return Err(format!(
            "workspace storage only supports {} files",
            ALLOWED_EXTENSIONS.join(", ")
        ));
    }

    for segment in segments {
        resolved.push(segment);
    }
    Ok(resolved)
}

/// 文件名清洗：保留可读字符，长度封顶，避免同名冲突时静默互相覆盖。
pub fn sanitize_file_stem(raw: &str) -> String {
    let stem: String = raw
        .trim()
        .chars()
        .map(|ch| {
            if ch.is_alphanumeric() || matches!(ch, '-' | '_' | '.' | ' ') {
                ch
            } else {
                '-'
            }
        })
        .collect();
    let collapsed = stem
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|ch: char| ch == '.' || ch == '-')
        .to_string();
    let capped: String = collapsed.chars().take(80).collect();
    if capped.is_empty() {
        "document".to_string()
    } else {
        capped
    }
}

/// 确定性短哈希：同名文件多次导入落到同一副本，天然幂等。
fn short_hash(input: &str) -> String {
    // FNV-1a 64：只为分散文件名，不承担安全职责，因此不需要密码学哈希。
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")[..10].to_string()
}

/// 工作区内的文档副本文件名：`{清洗后的stem}-{短哈希}.{ext}`。
pub fn managed_document_file_name(source_path: &Path) -> String {
    let stem = sanitize_file_stem(
        source_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("document"),
    );
    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| value == "pdf" || value == "md" || value == "markdown")
        .unwrap_or_else(|| "pdf".to_string());
    let hash = short_hash(&source_path.to_string_lossy());
    format!("{stem}-{hash}.{extension}")
}

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn restrict_directory_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    // 0700：工作区里可能有密钥配置和私人文献，默认不给同机其他账号读。
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn restrict_directory_permissions(_path: &Path) {}

/// 密钥文件必须是 0600。这条是整个方案的安全底线，不能省。
#[cfg(unix)]
fn restrict_secret_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_secret_permissions(_path: &Path) {}

/// 供 tauri_commands 的密钥读写调用：临时文件与最终文件都要 0600。
pub fn restrict_secret_permissions_public(path: &Path) {
    restrict_secret_permissions(path);
}

// ---------------------------------------------------------------------------
// 容量统计
// ---------------------------------------------------------------------------

pub fn measure_usage(dir: &Path) -> WorkspaceUsage {
    let mut usage = WorkspaceUsage {
        file_count: 0,
        total_bytes: 0,
        truncated: false,
    };
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            if usage.file_count >= MAX_SCAN_ENTRIES {
                usage.truncated = true;
                return usage;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(entry.path());
                continue;
            }
            usage.file_count += 1;
            usage.total_bytes = usage.total_bytes.saturating_add(
                entry
                    .metadata()
                    .map(|metadata| metadata.len())
                    .unwrap_or_default(),
            );
        }
    }
    usage
}

// ---------------------------------------------------------------------------
// 工作区根目录变更
// ---------------------------------------------------------------------------

fn copy_dir_all(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to)
        .map_err(|err| format!("failed to create {}: {err}", to.display()))?;
    for entry in std::fs::read_dir(from)
        .map_err(|err| format!("failed to read {}: {err}", from.display()))?
    {
        let entry = entry.map_err(|err| format!("failed to read dir entry: {err}"))?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|err| format!("failed to inspect {}: {err}", source.display()))?;
        if file_type.is_dir() {
            copy_dir_all(&source, &target)?;
        } else {
            std::fs::copy(&source, &target)
                .map_err(|err| format!("failed to copy {}: {err}", source.display()))?;
        }
    }
    Ok(())
}

/// 切换工作区根目录：先把旧内容整份复制到新位置，**复制成功后才改指针**。
/// 失败时旧工作区原封不动 —— 迁移不能让用户丢数据。
pub fn relocate(app_data_dir: &Path, target: &Path) -> Result<WorkspaceLayout, String> {
    let target = target.to_path_buf();
    if !target.is_absolute() {
        return Err("workspace location must be an absolute path".to_string());
    }
    let default = default_root(app_data_dir);
    if target == default {
        // 回到默认位置：删除指针即可，不需要搬数据。
        let _ = std::fs::remove_file(pointer_path(app_data_dir));
        return ensure_layout(app_data_dir);
    }
    if target
        == default_root(app_data_dir)
            .parent()
            .unwrap_or(Path::new("/"))
    {
        return Err("workspace location must be a dedicated folder".to_string());
    }
    if target.exists()
        && std::fs::read_dir(&target)
            .map(|mut e| e.next().is_some())
            .unwrap_or(false)
    {
        return Err(format!(
            "{} is not empty; choose an empty folder or a new one",
            target.display()
        ));
    }
    std::fs::create_dir_all(&target)
        .map_err(|err| format!("failed to create {}: {err}", target.display()))?;

    let current = ensure_layout(app_data_dir)?;
    if current.root != target {
        copy_dir_all(&current.root, &target)?;
        restrict_directory_permissions(&target);
    }
    write_pointer(app_data_dir, &target)?;
    ensure_layout(app_data_dir)
}

/// 清空派生缓存。文档、设置、密钥、历史都不在 cache/ 下，因此可安全删除。
pub fn clear_cache(layout: &WorkspaceLayout) -> Result<usize, String> {
    let before = measure_usage(&layout.cache_dir).file_count;
    if layout.cache_dir.exists() {
        std::fs::remove_dir_all(&layout.cache_dir)
            .map_err(|err| format!("failed to remove cache dir: {err}"))?;
    }
    std::fs::create_dir_all(&layout.cache_dir)
        .map_err(|err| format!("failed to recreate cache dir: {err}"))?;
    Ok(before)
}

pub fn into_info(layout: &WorkspaceLayout) -> WorkspaceInfo {
    WorkspaceInfo {
        root: layout.root.to_string_lossy().into_owned(),
        config_dir: layout.config_dir.to_string_lossy().into_owned(),
        documents_dir: layout.documents_dir.to_string_lossy().into_owned(),
        library_dir: layout.library_dir.to_string_lossy().into_owned(),
        history_dir: layout.history_dir.to_string_lossy().into_owned(),
        cache_dir: layout.cache_dir.to_string_lossy().into_owned(),
        is_custom: layout.is_custom,
        usage: measure_usage(&layout.root),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_layout, managed_document_file_name, measure_usage, resolve_in, sanitize_file_stem,
    };
    use std::path::{Path, PathBuf};

    fn temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("r0nix-workspace-test-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp app data dir");
        dir
    }

    #[test]
    fn layout_creates_every_managed_directory() {
        let app_data = temp_root("layout");
        let layout = ensure_layout(&app_data).expect("layout should be created");
        for dir in [
            &layout.root,
            &layout.config_dir,
            &layout.documents_dir,
            &layout.library_dir,
            &layout.history_dir,
            &layout.cache_dir,
        ] {
            assert!(dir.is_dir(), "{} should exist", dir.display());
        }
        assert!(!layout.is_custom);
        let _ = std::fs::remove_dir_all(&app_data);
    }

    #[test]
    fn nested_keys_resolve_under_the_workspace() {
        let root = Path::new("/tmp/ws");
        // assistHistory 一直在传这种多级 key；旧实现直接报错，历史因此只活在内存里。
        let resolved = resolve_in(root, "assist-history/doc-1.json").expect("nested key");
        assert_eq!(resolved, root.join("assist-history").join("doc-1.json"));
    }

    #[test]
    fn traversal_absolute_and_unknown_extensions_are_rejected() {
        let root = Path::new("/tmp/ws");
        for key in [
            "../escape.json",
            "assist-history/../../escape.json",
            "/etc/passwd.json",
            "config/settings.txt",
            ".hidden.json",
            "",
            "   ",
        ] {
            assert!(
                resolve_in(root, key).is_err(),
                "key {key:?} must be rejected"
            );
        }
    }

    #[test]
    fn windows_style_separators_are_normalised_before_validation() {
        let root = Path::new("/tmp/ws");
        let resolved = resolve_in(root, "assist-history\\doc-2.json").expect("backslashes");
        assert_eq!(resolved, root.join("assist-history").join("doc-2.json"));
    }

    #[test]
    fn managed_names_are_stable_and_readable() {
        let first = managed_document_file_name(Path::new("/papers/Deep Learning.pdf"));
        let second = managed_document_file_name(Path::new("/papers/Deep Learning.pdf"));
        let other = managed_document_file_name(Path::new("/papers/Other:Notes.md"));
        assert_eq!(first, second, "same source must map to the same copy");
        assert!(first.ends_with(".pdf"));
        assert!(first.starts_with("Deep Learning-"));
        assert!(other.ends_with(".md"));
        assert!(!other.contains(':'));
    }

    #[test]
    fn file_stems_stay_within_bounds() {
        assert_eq!(sanitize_file_stem("  ..  "), "document");
        assert_eq!(sanitize_file_stem("a/b\\c"), "a-b-c");
        assert!(sanitize_file_stem(&"x".repeat(400)).chars().count() <= 80);
    }

    #[test]
    fn usage_reports_nothing_for_a_fresh_workspace() {
        let app_data = temp_root("usage");
        let layout = ensure_layout(&app_data).expect("layout");
        let usage = measure_usage(&layout.cache_dir);
        assert_eq!(usage.file_count, 0);
        assert_eq!(usage.total_bytes, 0);
        assert!(!usage.truncated);
        let _ = std::fs::remove_dir_all(&app_data);
    }
}
