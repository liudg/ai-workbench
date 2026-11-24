//! 全局可定制快捷键持久化（`<data_dir>/keybindings.json`）与外部编辑热重载。

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use aiwb_core::rpc::TOPIC_KEYBINDINGS;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{ServiceResult, Services};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeybindingRule {
    pub command: String,
    #[serde(default)]
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeybindingsSnapshot {
    pub path: String,
    pub rules: Vec<KeybindingRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileStat {
    modified: Option<SystemTime>,
    len: u64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileFingerprint {
    stat: FileStat,
    digest: u64,
}

#[derive(Default)]
pub(crate) struct KeybindingsState {
    io_lock: Mutex<()>,
    last_fingerprint: Mutex<Option<FileFingerprint>>,
    last_good_rules: Mutex<Vec<KeybindingRule>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetKeybindings {
    rules: Vec<KeybindingRule>,
}

fn clean_rules(rules: Vec<KeybindingRule>) -> Vec<KeybindingRule> {
    rules
        .into_iter()
        .filter_map(|mut rule| {
            rule.command = rule.command.trim().to_string();
            if rule.command.is_empty() {
                return None;
            }
            rule.key = rule.key.trim().to_string();
            rule.when = rule
                .when
                .map(|w| w.trim().to_string())
                .filter(|w| !w.is_empty());
            Some(rule)
        })
        .collect()
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn stat_keybindings_file(path: &Path) -> std::io::Result<Option<FileStat>> {
    match std::fs::metadata(path) {
        Ok(meta) => Ok(Some(FileStat {
            modified: meta.modified().ok(),
            len: meta.len(),
        })),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

fn read_file_with_fingerprint(
    path: &Path,
    known_stat: Option<FileStat>,
) -> std::io::Result<(String, FileFingerprint)> {
    let stat = match known_stat {
        Some(stat) => stat,
        None => {
            let meta = std::fs::metadata(path)?;
            FileStat {
                modified: meta.modified().ok(),
                len: meta.len(),
            }
        }
    };
    let raw = std::fs::read_to_string(path)?;
    let fp = FileFingerprint {
        stat,
        digest: hash_bytes(raw.as_bytes()),
    };
    Ok((raw, fp))
}

fn parse_keybindings_text(raw: &str) -> Result<Vec<KeybindingRule>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let val: Value =
        serde_json::from_str(trimmed).map_err(|e| format!("keybindings.json 语法错误：{e}"))?;
    match val {
        Value::Array(_) => serde_json::from_value::<Vec<KeybindingRule>>(val)
            .map(clean_rules)
            .map_err(|e| format!("keybindings.json 规则格式错误：{e}")),
        Value::Object(mut map) => match map.remove("rules") {
            Some(rules_val) => serde_json::from_value::<Vec<KeybindingRule>>(rules_val)
                .map(clean_rules)
                .map_err(|e| format!("keybindings.json rules 字段格式错误：{e}")),
            None => Err("keybindings.json 顶层应为 JSON 数组 `[...]`".into()),
        },
        _ => Err("keybindings.json 顶层应为 JSON 数组 `[...]`".into()),
    }
}

impl Services {
    pub(crate) fn keybindings_path(&self) -> PathBuf {
        self.data_dir.join("keybindings.json")
    }

    /// 只读加载 `<data_dir>/keybindings.json`；文件不存在时直接返回空规则列表，不在磁盘创建空文件。
    pub(crate) fn read_keybindings(&self) -> KeybindingsSnapshot {
        let _io = self.keybindings.io_lock.lock().unwrap();
        let path = self.keybindings_path();
        self.load_keybindings_locked(&path, None).0
    }

    fn load_keybindings_locked(
        &self,
        path: &Path,
        known_stat: Option<FileStat>,
    ) -> (KeybindingsSnapshot, Option<FileFingerprint>) {
        let path_str = path.to_string_lossy().into_owned();
        match read_file_with_fingerprint(path, known_stat) {
            Ok((raw, fp)) => {
                *self.keybindings.last_fingerprint.lock().unwrap() = Some(fp);
                let snap = match parse_keybindings_text(&raw) {
                    Ok(rules) => {
                        *self.keybindings.last_good_rules.lock().unwrap() = rules.clone();
                        KeybindingsSnapshot {
                            path: path_str,
                            rules,
                            error: None,
                        }
                    }
                    Err(err) => KeybindingsSnapshot {
                        path: path_str,
                        rules: self.keybindings.last_good_rules.lock().unwrap().clone(),
                        error: Some(err),
                    },
                };
                (snap, Some(fp))
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                *self.keybindings.last_fingerprint.lock().unwrap() = None;
                *self.keybindings.last_good_rules.lock().unwrap() = Vec::new();
                (
                    KeybindingsSnapshot {
                        path: path_str,
                        rules: Vec::new(),
                        error: None,
                    },
                    None,
                )
            }
            Err(err) => {
                let prev = *self.keybindings.last_fingerprint.lock().unwrap();
                (
                    KeybindingsSnapshot {
                        path: path_str,
                        rules: self.keybindings.last_good_rules.lock().unwrap().clone(),
                        error: Some(format!("读取 keybindings.json 失败：{err}")),
                    },
                    prev,
                )
            }
        }
    }

    pub(crate) fn set_keybindings(
        &self,
        params: SetKeybindings,
    ) -> ServiceResult<KeybindingsSnapshot> {
        let rules = clean_rules(params.rules);
        self.write_keybindings_rules(&rules)
    }

    fn write_keybindings_rules(&self, rules: &[KeybindingRule]) -> ServiceResult<KeybindingsSnapshot> {
        let path = self.keybindings_path();
        let mut serialized =
            serde_json::to_string_pretty(rules).map_err(|e| format!("序列化快捷键失败：{e}"))?;
        serialized.push('\n');

        {
            let _io = self.keybindings.io_lock.lock().unwrap();
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("创建目录 {} 失败：{e}", parent.display()))?;
            }
            let tmp = path.with_file_name(format!(
                "keybindings.json.tmp-{}",
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::write(&tmp, serialized.as_bytes())
                .map_err(|e| format!("写入临时文件 {} 失败：{e}", tmp.display()))?;
            if let Err(_rename_err) = std::fs::rename(&tmp, &path) {
                let write_res = std::fs::write(&path, serialized.as_bytes());
                let _ = std::fs::remove_file(&tmp);
                write_res.map_err(|e| format!("写入 {} 失败：{e}", path.display()))?;
            }
            let meta = std::fs::metadata(&path).ok();
            let stat = FileStat {
                modified: meta.as_ref().and_then(|m| m.modified().ok()),
                len: meta.map(|m| m.len()).unwrap_or(serialized.len() as u64),
            };
            *self.keybindings.last_fingerprint.lock().unwrap() = Some(FileFingerprint {
                stat,
                digest: hash_bytes(serialized.as_bytes()),
            });
            *self.keybindings.last_good_rules.lock().unwrap() = rules.to_vec();
        }

        let snap = KeybindingsSnapshot {
            path: path.to_string_lossy().into_owned(),
            rules: rules.to_vec(),
            error: None,
        };
        let _ = self.publish_keybindings(&snap);
        Ok(snap)
    }

    fn publish_keybindings(&self, snap: &KeybindingsSnapshot) -> ServiceResult<()> {
        self.hub.publish_with(TOPIC_KEYBINDINGS, || {
            Ok(((), serde_json::to_value(snap).map_err(|e| e.to_string())?))
        })
    }

    /// 监听 `<data_dir>/keybindings.json` 外部文件改动，变化后立即向前端推送热更新快照。
    pub fn start_keybindings_watcher(self: &Arc<Self>) {
        let _ = self.read_keybindings();
        let services = Arc::clone(self);
        let mut shutdown = self.shutdown.subscribe();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(1));
            loop {
                tokio::select! {
                    _ = tick.tick() => {
                        let svc = Arc::clone(&services);
                        let maybe_snap = tokio::task::spawn_blocking(move || -> Option<KeybindingsSnapshot> {
                            let _io = svc.keybindings.io_lock.lock().unwrap();
                            let path = svc.keybindings_path();
                            let current_stat = stat_keybindings_file(&path).ok()?;
                            let prev_fp = *svc.keybindings.last_fingerprint.lock().unwrap();
                            if prev_fp.map(|fp| fp.stat) == current_stat {
                                return None;
                            }
                            let (snap, new_fp) = svc.load_keybindings_locked(&path, current_stat);
                            (prev_fp.map(|fp| fp.digest) != new_fp.map(|fp| fp.digest)).then_some(snap)
                        })
                        .await
                        .ok()
                        .flatten();
                        if let Some(snap) = maybe_snap {
                            let _ = services.publish_keybindings(&snap);
                        }
                    }
                    _ = async {
                        let _ = shutdown.wait_for(|stop| *stop).await;
                    } => break,
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_array_and_wrapped_rules_and_reports_invalid_json() {
        let rules = parse_keybindings_text(
            r#"[{"command":"command.open","key":"mod+p","when":"!terminalFocus"}]"#,
        )
        .unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].command, "command.open");
        assert_eq!(rules[0].key, "mod+p");
        assert_eq!(rules[0].when.as_deref(), Some("!terminalFocus"));

        let wrapped = parse_keybindings_text(r#"{"rules":[{"command":"-chat.find","key":""}]}"#)
            .unwrap();
        assert_eq!(wrapped.len(), 1);
        assert_eq!(wrapped[0].command, "-chat.find");

        let err = parse_keybindings_text("{ broken json ").unwrap_err();
        assert!(err.contains("语法错误"));
    }

    #[test]
    fn read_keybindings_does_not_create_file_and_set_writes_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let info = aiwb_core::DaemonInfo {
            version: "test".into(),
            build: String::new(),
            pid: 1,
            port: 0,
            token: "t".into(),
        };
        let services = Services::new(
            Arc::new(aiwb_store::Store::open_in_memory().unwrap()),
            info,
            dir.path().to_path_buf(),
        );
        let snap = services.read_keybindings();
        assert!(snap.rules.is_empty());
        assert!(snap.error.is_none());
        assert!(!services.keybindings_path().exists());

        let saved = services
            .set_keybindings(SetKeybindings {
                rules: vec![KeybindingRule {
                    command: "command.open".into(),
                    key: "mod+k".into(),
                    when: None,
                }],
            })
            .unwrap();
        assert_eq!(saved.rules.len(), 1);
        assert!(services.keybindings_path().is_file());
        // 无残留临时文件
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec!["keybindings.json".to_string()]);
    }
}
