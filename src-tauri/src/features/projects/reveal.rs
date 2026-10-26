//! 在系统文件管理器里打开项目根目录。

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use aiwb_core::models::strip_verbatim_prefix;

/// 项目保存的本地根目录。空路径、不存在或不是文件夹时返回给界面的中文说明。
pub(crate) fn project_folder(path: &str) -> Result<PathBuf, String> {
    let trimmed = strip_verbatim_prefix(path.trim());
    let trimmed = trimmed.trim();
    if trimmed.is_empty() {
        return Err("这个项目没有本地目录".into());
    }
    let dir = PathBuf::from(trimmed);
    match fs::metadata(&dir) {
        Ok(meta) if meta.is_dir() => Ok(dir),
        Ok(_) => Err("无法打开，该路径不是文件夹".into()),
        Err(err) if err.kind() == ErrorKind::NotFound => Err("无法打开，项目目录不存在".into()),
        Err(_) => Err("无法读取项目目录".into()),
    }
}

pub(crate) fn file_manager_program(os: &str) -> &'static str {
    match os {
        "windows" => "explorer",
        "macos" => "open",
        _ => "xdg-open",
    }
}

/// Windows 的 explorer 把 `/` 当成开关，目录参数改成反斜杠。
pub(crate) fn file_manager_argument(os: &str, dir: &Path) -> String {
    let text = dir.to_string_lossy();
    if os == "windows" {
        text.replace('/', "\\")
    } else {
        text.into_owned()
    }
}

pub(crate) fn reveal_project_folder(path: &str) -> Result<(), String> {
    let dir = project_folder(path)?;
    let os = std::env::consts::OS;
    let mut child = Command::new(file_manager_program(os))
        .arg(file_manager_argument(os, &dir))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "无法在资源管理器中打开".to_string())?;
    // 文件管理器会留在前台。放到后台回收，避免拖住这次命令。
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("awb-reveal-{nanos}"));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn empty_path_is_not_a_local_folder() {
        assert_eq!(project_folder("").unwrap_err(), "这个项目没有本地目录");
        assert_eq!(project_folder("   ").unwrap_err(), "这个项目没有本地目录");
    }

    #[test]
    fn missing_directory_is_rejected() {
        let scratch = TempDir::new();
        let missing = scratch.0.join("gone");
        assert_eq!(
            project_folder(&missing.to_string_lossy()).unwrap_err(),
            "无法打开，项目目录不存在"
        );
    }

    #[test]
    fn file_path_is_rejected() {
        let scratch = TempDir::new();
        let file = scratch.0.join("notes.txt");
        fs::write(&file, "x").unwrap();
        assert_eq!(
            project_folder(&file.to_string_lossy()).unwrap_err(),
            "无法打开，该路径不是文件夹"
        );
    }

    #[test]
    fn existing_directory_is_accepted() {
        let scratch = TempDir::new();
        let got = project_folder(&scratch.0.to_string_lossy()).unwrap();
        assert!(got.is_dir());
    }

    #[test]
    fn windows_opens_the_folder_with_explorer() {
        let (program, argument) = (
            file_manager_program("windows"),
            file_manager_argument("windows", Path::new("C:/work/app")),
        );
        assert_eq!(program, "explorer");
        assert_eq!(argument, r"C:\work\app");
        assert_eq!(file_manager_program("macos"), "open");
        assert_eq!(file_manager_program("linux"), "xdg-open");
    }
}
