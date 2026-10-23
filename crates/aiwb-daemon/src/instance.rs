//! 单实例锁和 `daemon.json`。

use std::fs::{File, OpenOptions};
use std::path::Path;

use aiwb_core::{DaemonInfo, DAEMON_INFO_FILE};
use fs4::fs_std::FileExt;

const LOCK_FILE: &str = "daemon.lock";

/// 拿到锁返回文件句柄，进程退出前要一直持有；已被别的实例占用时返回 None。
pub(crate) fn acquire(data_dir: &Path) -> Result<Option<File>, String> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data_dir.join(LOCK_FILE))
        .map_err(|e| format!("打开 {LOCK_FILE} 失败：{e}"))?;
    match file.try_lock_exclusive() {
        Ok(true) => Ok(Some(file)),
        Ok(false) => Ok(None),
        Err(err) => Err(format!("锁定 {LOCK_FILE} 失败：{err}")),
    }
}

/// 先写临时文件再改名，读的一方不会看到写了一半的内容。
pub(crate) fn write_info(data_dir: &Path, info: &DaemonInfo) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(info).expect("serialize daemon info");
    let tmp = data_dir.join(format!("{DAEMON_INFO_FILE}.tmp"));
    std::fs::write(&tmp, raw).map_err(|e| format!("写 {DAEMON_INFO_FILE} 失败：{e}"))?;
    std::fs::rename(&tmp, data_dir.join(DAEMON_INFO_FILE))
        .map_err(|e| format!("写 {DAEMON_INFO_FILE} 失败：{e}"))
}

/// 只删自己写的那份。
pub(crate) fn remove_info(data_dir: &Path, pid: u32) {
    let path = data_dir.join(DAEMON_INFO_FILE);
    let ours = std::fs::read(&path)
        .ok()
        .and_then(|raw| serde_json::from_slice::<DaemonInfo>(&raw).ok())
        .is_some_and(|info| info.pid == pid);
    if ours {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn second_acquire_fails_while_first_held() {
        let dir = tempfile::tempdir().unwrap();
        let first = acquire(dir.path()).unwrap();
        assert!(first.is_some());
        assert!(acquire(dir.path()).unwrap().is_none());
        drop(first);
        assert!(acquire(dir.path()).unwrap().is_some());
    }

    #[test]
    fn remove_info_keeps_other_pid() {
        let dir = tempfile::tempdir().unwrap();
        let info = DaemonInfo {
            version: "1".into(),
            build: String::new(),
            pid: 42,
            port: 1,
            token: "t".into(),
        };
        write_info(dir.path(), &info).unwrap();
        remove_info(dir.path(), 7);
        assert!(dir.path().join(DAEMON_INFO_FILE).exists());
        remove_info(dir.path(), 42);
        assert!(!dir.path().join(DAEMON_INFO_FILE).exists());
    }
}
