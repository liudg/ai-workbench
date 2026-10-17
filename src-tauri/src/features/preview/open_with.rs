//! 用系统程序打开预览中的文件。默认程序各平台都有；选择应用只在做得到的系统上出现。

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileOpenCapabilities {
    pub choose_app: bool,
}

pub fn choose_app_supported() -> bool {
    cfg!(windows)
}

pub fn resolve_open_mode(mode: Option<&str>, choose_supported: bool) -> Result<&'static str, &'static str> {
    match mode.unwrap_or("default").trim() {
        "" | "default" => Ok("default"),
        "choose" if choose_supported => Ok("choose"),
        "choose" => Err("当前系统不能选择应用"),
        _ => Err("无法在外部打开"),
    }
}

pub fn open_resolved(target: &str, mode: &str) -> Result<(), String> {
    match mode {
        "default" => super::browser::open_in_shell(target),
        "choose" => spawn_choose(target),
        _ => Err("无法在外部打开".into()),
    }
}

fn spawn_choose(target: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("rundll32.exe")
            .arg("shell32.dll,OpenAs_RunDLL")
            .arg(target)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|_| "无法在外部打开".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = target;
        Err("当前系统不能选择应用".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_open_does_not_need_a_chooser() {
        assert_eq!(resolve_open_mode(None, false), Ok("default"));
        assert_eq!(resolve_open_mode(Some("default"), false), Ok("default"));
        assert_eq!(resolve_open_mode(Some(" choose "), false), Err("当前系统不能选择应用"));
        assert_eq!(resolve_open_mode(Some("choose"), true), Ok("choose"));
        assert_eq!(resolve_open_mode(Some("other"), true), Err("无法在外部打开"));
    }
}
