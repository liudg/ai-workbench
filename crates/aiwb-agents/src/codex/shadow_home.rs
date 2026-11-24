//! Codex 影子主目录（Shadow Home）布局：
//! 隔离每个实例私有的 `auth.json`、`auth.lock` 与 `models_cache.json`，
//! 同时用目录软链（Windows 下优先 `symlink_dir`，无特权时自动回退 NTFS Directory Junction `mklink /J`）
//! 共享宿主主目录的 `skills`、`sessions`、`plugins` 等目录。

use std::fs;
use std::path::{Path, PathBuf};

use aiwb_core::models::IsolationMode;

use crate::instance::{paths_overlap, user_home_dir, InstanceOverlay};

const KNOWN_SHARED_DIRECTORIES: &[&str] = &[
    "sessions",
    "archived_sessions",
    "sqlite",
    "shell_snapshots",
    "worktrees",
    "skills",
    "plugins",
    "cache",
    "logs",
    "mcp-oauth-locks",
    "thread-writer-locks",
];

const PRIVATE_ENTRY_NAMES: &[&str] = &[
    "auth.json",
    "auth.json.lock",
    "auth.lock",
    "models_cache.json",
];

const SHADOW_LOCAL_ENTRY_NAMES: &[&str] = &[
    "log",
    "memories",
    "memories_v2",
    "tmp",
    ".tmp",
    ".DS_Store",
];

const REPLACEABLE_SHARED_ENTRIES: &[&str] = &[
    "mcp-oauth-locks",
    "thread-writer-locks",
];

/// 允许通过软链或硬链直接共享的只读/标识类根文件；其余静态配置（如 `config.toml`）走独立复制，
/// 可变数据库/WAL/锁文件绝不跨目录硬链或软链，以防多目录各自建 `-wal` / `-shm` 损坏 SQLite。
const LINKABLE_STATIC_FILES: &[&str] = &["AGENTS.md", "cap_sid"];

fn is_mutable_db_or_lock_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains(".sqlite")
        || lower.ends_with(".db")
        || lower.ends_with("-wal")
        || lower.ends_with("-shm")
        || lower.ends_with("-journal")
        || lower.ends_with(".lock")
}

fn is_private_or_local_entry(name: &str) -> bool {
    PRIVATE_ENTRY_NAMES.contains(&name)
        || SHADOW_LOCAL_ENTRY_NAMES.contains(&name)
        || is_mutable_db_or_lock_file(name)
        || (name.starts_with("models_cache.") && name.ends_with(".json"))
        || name.starts_with(".codex-provisioning")
}

/// 解析当前 Codex 实例最终生效的 `CODEX_HOME`（若为隔离/影子目录则一并完成目录初始化；显式 `overlay.env` 中的 `CODEX_HOME` 优先级最高）。
pub fn effective_codex_home(overlay: &InstanceOverlay) -> Result<Option<PathBuf>, String> {
    let _prepared = prepare_codex_home(overlay)?;
    let resolved = overlay.resolve_config_dir("CODEX_HOME", ".codex");
    if overlay
        .env_var("CODEX_HOME")
        .is_some_and(|v| !v.trim().is_empty())
    {
        if let Some(dir) = &resolved {
            let _ = fs::create_dir_all(dir);
        }
    }
    Ok(resolved)
}

/// 为当前 Codex 实例准备有效 `CODEX_HOME`。返回 `None` 表示沿用宿主环境缺省目录。
pub fn prepare_codex_home(overlay: &InstanceOverlay) -> Result<Option<PathBuf>, String> {
    match overlay.isolation_mode {
        IsolationMode::HostDefault => {
            let Some(home) = overlay.home_path.as_ref() else {
                return Ok(None);
            };
            fs::create_dir_all(home)
                .map_err(|err| format!("无法创建 Codex 目录 {}：{err}", home.display()))?;
            Ok(Some(home.clone()))
        }
        IsolationMode::IsolatedHome => {
            let home = overlay
                .home_path
                .as_ref()
                .ok_or_else(|| "独立实例缺少目标目录".to_string())?;
            fs::create_dir_all(home)
                .map_err(|err| format!("无法创建 Codex 隔离目录 {}：{err}", home.display()))?;
            Ok(Some(home.clone()))
        }
        IsolationMode::ShadowHome => {
            let effective = overlay
                .home_path
                .as_ref()
                .ok_or_else(|| "Codex Shadow Home 缺少影子目录路径".to_string())?;
            let shared = overlay
                .shared_home_path
                .clone()
                .or_else(|| user_home_dir().map(|h| h.join(".codex")))
                .ok_or_else(|| "无法确定宿主 ~/.codex 主目录".to_string())?;

            if paths_overlap(&shared, effective) {
                return Err(format!(
                    "Codex 影子目录（{}）不能与共享主目录（{}）相同或互为父子目录",
                    effective.display(),
                    shared.display()
                ));
            }

            fs::create_dir_all(&shared)
                .map_err(|err| format!("无法创建共享主目录 {}：{err}", shared.display()))?;
            fs::create_dir_all(effective)
                .map_err(|err| format!("无法创建影子目录 {}：{err}", effective.display()))?;

            // 清理影子目录下任何意外遗留为软链/重解析点的私有凭据或 SQLite/锁文件。
            if let Ok(existing_entries) = fs::read_dir(effective) {
                for entry in existing_entries.flatten() {
                    let fname = entry.file_name();
                    if let Some(name) = fname.to_str() {
                        if is_private_or_local_entry(name) && is_reparse_or_symlink(&entry.path()) {
                            let _ = remove_link(&entry.path());
                        }
                    }
                }
            }

            for dir_name in KNOWN_SHARED_DIRECTORIES {
                let target = shared.join(dir_name);
                let _ = fs::create_dir_all(&target);
                let link = effective.join(dir_name);
                ensure_dir_link(&link, &target, REPLACEABLE_SHARED_ENTRIES.contains(dir_name))?;
            }

            // 共享主目录下的其余子目录（如 `.sandbox`）通过目录联接共享；
            // `AGENTS.md` / `cap_sid` 桥接共享，`config.toml` 等静态配置在缺失时复制一份（绝不硬链可变 `.sqlite` 文件）。
            if let Ok(entries) = fs::read_dir(&shared) {
                for entry in entries.flatten() {
                    let file_name = entry.file_name();
                    let Some(name) = file_name.to_str() else {
                        continue;
                    };
                    if is_private_or_local_entry(name) || KNOWN_SHARED_DIRECTORIES.contains(&name) {
                        continue;
                    }
                    let target = entry.path();
                    let link = effective.join(name);
                    if target.is_dir() {
                        let _ = ensure_dir_link(&link, &target, false);
                    } else if target.is_file() && !link.exists() {
                        if LINKABLE_STATIC_FILES.contains(&name) {
                            ensure_file_bridge(&link, &target);
                        } else {
                            let _ = fs::copy(&target, &link);
                        }
                    }
                }
            }

            Ok(Some(effective.clone()))
        }
    }
}

pub(crate) fn is_reparse_or_symlink(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub(crate) fn remove_link(link: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        if fs::remove_dir(link).is_ok() {
            return Ok(());
        }
    }
    fs::remove_file(link)
}

fn ensure_dir_link(link: &Path, target: &Path, replaceable: bool) -> Result<(), String> {
    if is_reparse_or_symlink(link) {
        if let (Ok(real_link), Ok(real_target)) = (fs::canonicalize(link), fs::canonicalize(target))
        {
            if real_link == real_target {
                return Ok(());
            }
        }
        remove_link(link)
            .map_err(|err| format!("无法替换旧软链 {}：{err}", link.display()))?;
    } else if link.exists() {
        if replaceable {
            let _ = fs::remove_dir_all(link);
        } else {
            // 如果已经是空目录，替换成共享链接；否则保留用户自己的目录以免误删数据。
            let is_empty_dir = link.is_dir()
                && fs::read_dir(link)
                    .map(|mut it| it.next().is_none())
                    .unwrap_or(false);
            if is_empty_dir {
                let _ = fs::remove_dir(link);
            } else {
                return Ok(());
            }
        }
    }

    create_dir_link(link, target)
}

fn ensure_file_bridge(link: &Path, target: &Path) {
    #[cfg(unix)]
    {
        if std::os::unix::fs::symlink(target, link).is_ok() {
            return;
        }
    }
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_file(target, link).is_ok() {
            return;
        }
    }
    if fs::hard_link(target, link).is_ok() {
        return;
    }
    let _ = fs::copy(target, link);
}

#[cfg(unix)]
fn create_dir_link(link: &Path, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link).map_err(|err| {
        format!(
            "无法创建 Codex 共享目录软链 {} -> {}：{err}",
            link.display(),
            target.display()
        )
    })
}

#[cfg(windows)]
fn create_dir_link(link: &Path, target: &Path) -> Result<(), String> {
    if std::os::windows::fs::symlink_dir(target, link).is_ok() {
        return Ok(());
    }
    // 普通 Windows 账号未开启开发者模式时 symlink_dir 报 1314；NTFS Junction 无需管理员特权。
    use std::process::{Command, Stdio};
    let mut cmd = Command::new("cmd");
    cmd.args(["/d", "/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    aiwb_proc::hide_console_std(&mut cmd);
    let status = cmd
        .status()
        .map_err(|err| format!("无法调用 mklink 创建目录联接：{err}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "创建 Codex 影子目录联接失败：{} -> {}",
            link.display(),
            target.display()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shadow_home_isolates_auth_and_sqlite_and_copies_config_without_hardlinking() {
        let root = tempfile::tempdir().unwrap();
        let shared = root.path().join("shared-codex");
        let shadow = root.path().join("shadow-work");
        fs::create_dir_all(shared.join("skills/demo")).unwrap();
        fs::write(shared.join("auth.json"), r#"{"account":"personal"}"#).unwrap();
        fs::write(shared.join("config.toml"), "model = \"gpt-5\"\n").unwrap();
        fs::write(shared.join("state_5.sqlite"), "sqlite-bytes").unwrap();
        fs::write(shared.join("state_5.sqlite-wal"), "wal-bytes").unwrap();
        fs::write(shared.join("skills/demo/SKILL.md"), "# Demo Skill\n").unwrap();

        let overlay = InstanceOverlay {
            instance_id: "codex-work".into(),
            isolation_mode: IsolationMode::ShadowHome,
            home_path: Some(shadow.clone()),
            shared_home_path: Some(shared.clone()),
            ..Default::default()
        };

        let resolved = prepare_codex_home(&overlay).unwrap().unwrap();
        assert_eq!(resolved, shadow);

        // 影子目录拥有独立 auth.json，不污染宿主 ~/.codex/auth.json
        assert!(!shadow.join("auth.json").exists());
        fs::write(shadow.join("auth.json"), r#"{"account":"work"}"#).unwrap();
        assert_eq!(
            fs::read_to_string(shared.join("auth.json")).unwrap(),
            r#"{"account":"personal"}"#
        );

        // 可变 SQLite / WAL 文件绝不跨目录硬链或软链
        assert!(!shadow.join("state_5.sqlite").exists());
        assert!(!shadow.join("state_5.sqlite-wal").exists());

        // `config.toml` 为独立复制：修改影子目录 config.toml 不篡改共享主目录的 config.toml
        assert!(shadow.join("config.toml").is_file());
        assert!(!is_reparse_or_symlink(&shadow.join("config.toml")));
        fs::write(shadow.join("config.toml"), "model = \"gpt-5-mini\"\n").unwrap();
        assert_eq!(
            fs::read_to_string(shared.join("config.toml")).unwrap(),
            "model = \"gpt-5\"\n"
        );

        // 共享技能与会话历史通过软链/Junction 双向互通
        assert_eq!(
            fs::read_to_string(shadow.join("skills/demo/SKILL.md")).unwrap(),
            "# Demo Skill\n"
        );
        fs::write(shadow.join("sessions/t1.jsonl"), "{}\n").unwrap();
        assert!(shared.join("sessions/t1.jsonl").is_file());

        // 嵌套父子目录必须被拒绝，防止产生递归联接环
        let nested = InstanceOverlay {
            instance_id: "codex-nested".into(),
            isolation_mode: IsolationMode::ShadowHome,
            home_path: Some(shared.join("sub-shadow")),
            shared_home_path: Some(shared.clone()),
            ..Default::default()
        };
        assert!(prepare_codex_home(&nested).is_err());

        let reverse_nested = InstanceOverlay {
            instance_id: "codex-rev-nested".into(),
            isolation_mode: IsolationMode::ShadowHome,
            home_path: Some(root.path().to_path_buf()),
            shared_home_path: Some(shared),
            ..Default::default()
        };
        assert!(prepare_codex_home(&reverse_nested).is_err());
    }
}
