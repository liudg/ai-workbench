//! 单实例唤醒、`aiwb <目录>` 命令行参数与 `aiwb://` 深层链接路由。
//!
//! 冷启动时 `.setup()` 早于前端挂载，因此解析出的 [`LaunchIntent`] 先存入 [`LaunchQueue`]，
//! 前端挂载后调用 [`drain_launch_intents`] 取走首批意图，并监听 [`LAUNCH_INTENT_EVENT`] 处理后续唤醒。

use std::path::Path;
use std::sync::Mutex;

use aiwb_core::models::strip_verbatim_prefix;
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

pub const LAUNCH_INTENT_EVENT: &str = "aiwb://launch-intent";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LaunchIntent {
    Directory {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        prompt: Option<String>,
    },
    NewPrompt {
        prompt: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        project: Option<String>,
    },
}

#[derive(Default)]
pub struct LaunchQueue(Mutex<Vec<LaunchIntent>>);

impl LaunchQueue {
    pub fn push_many(&self, intents: impl IntoIterator<Item = LaunchIntent>) -> bool {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let prev_len = guard.len();
        guard.extend(intents);
        guard.len() > prev_len
    }

    pub fn drain(&self) -> Vec<LaunchIntent> {
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *guard)
    }
}

#[tauri::command]
pub fn drain_launch_intents(state: tauri::State<'_, LaunchQueue>) -> Vec<LaunchIntent> {
    state.drain()
}

pub fn enqueue_and_emit(app: &AppHandle, intents: Vec<LaunchIntent>) {
    if intents.is_empty() {
        return;
    }
    if let Some(queue) = app.try_state::<LaunchQueue>() {
        if queue.push_many(intents) {
            let _ = app.emit(LAUNCH_INTENT_EVENT, ());
        }
    }
}

/// 第二个实例启动时由 `tauri-plugin-single-instance` 回调触发：
/// 始终唤醒并聚焦主窗口（即使托盘常驻隐藏状态），再解析命令行路径或 `aiwb://` 链接。
pub fn handle_single_instance(app: &AppHandle, argv: Vec<String>, cwd: String) {
    crate::tray::show_main_window(app);
    let base_dir = {
        let trimmed = cwd.trim();
        (!trimmed.is_empty()).then(|| Path::new(trimmed))
    };
    let intents = parse_cli_args(&argv, base_dir);
    enqueue_and_emit(app, intents);
}

/// 在 `.setup()` 中完成协议注册、冷启动参数收集与运行期 `on_open_url` 绑定。
pub fn setup(app: &AppHandle) {
    #[cfg(any(windows, target_os = "linux"))]
    {
        // 开发态与便携/安装态均尝试注册当前用户的 `aiwb://` 协议处理器，失败不阻断启动。
        let _ = app.deep_link().register_all();
    }

    let cwd = std::env::current_dir().ok();
    let raw_args: Vec<String> = std::env::args_os()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let mut cold_intents = parse_cli_args(&raw_args, cwd.as_deref());

    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            if let Some(intent) = parse_deep_link_url(url.as_str()) {
                if !cold_intents.contains(&intent) {
                    cold_intents.push(intent);
                }
            }
        }
    }
    enqueue_and_emit(app, cold_intents);

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        crate::tray::show_main_window(&handle);
        let intents: Vec<LaunchIntent> = event
            .urls()
            .into_iter()
            .filter_map(|url| parse_deep_link_url(url.as_str()))
            .collect();
        enqueue_and_emit(&handle, intents);
    });
}

/// 解析进程 `argv`（首项是可执行文件路径）：
/// - 忽略 `-` 开头的标志参数；
/// - 识别 `aiwb://...` 深层链接；
/// - 其余参数按 `base_dir` 解析为现有目录（若指向现有文件则取其父目录）。
pub fn parse_cli_args(argv: &[String], base_dir: Option<&Path>) -> Vec<LaunchIntent> {
    let mut intents = Vec::new();
    for raw in argv.iter().skip(1) {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.starts_with('-') {
            continue;
        }
        if starts_with_aiwb_scheme(trimmed) {
            if let Some(intent) = parse_deep_link_url(trimmed) {
                intents.push(intent);
            }
            continue;
        }
        if let Some(dir) = resolve_cli_directory(trimmed, base_dir) {
            intents.push(LaunchIntent::Directory {
                path: dir,
                prompt: None,
            });
        }
    }
    intents
}

fn starts_with_aiwb_scheme(value: &str) -> bool {
    value
        .get(..7)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("aiwb://"))
}

fn resolve_cli_directory(raw: &str, base_dir: Option<&Path>) -> Option<String> {
    if let Ok(url) = Url::parse(raw) {
        if url.scheme().eq_ignore_ascii_case("file") {
            if let Ok(file_path) = url.to_file_path() {
                return existing_target_directory(&file_path);
            }
        }
    }

    if let Some(dir) = candidate_to_existing_dir(raw, base_dir) {
        return Some(dir);
    }

    // 兼容 Windows cmd 中 `aiwb "G:\repo\"` 因反斜杠转义引号留下的尾随 `"`。
    let unquoted = raw.trim_matches('"').trim();
    if !unquoted.is_empty() && unquoted != raw {
        return candidate_to_existing_dir(unquoted, base_dir);
    }
    None
}

fn candidate_to_existing_dir(candidate: &str, base_dir: Option<&Path>) -> Option<String> {
    let path = Path::new(candidate);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else if let Some(base) = base_dir {
        base.join(path)
    } else {
        path.to_path_buf()
    };
    existing_target_directory(&resolved)
}

fn existing_target_directory(path: &Path) -> Option<String> {
    let dir = if path.is_dir() {
        path.to_path_buf()
    } else if path.is_file() {
        path.parent()?.to_path_buf()
    } else {
        return None;
    };
    if !dir.is_dir() {
        return None;
    }
    let canonical = dir.canonicalize().unwrap_or(dir);
    Some(strip_verbatim_prefix(&canonical.to_string_lossy()))
}

fn strip_leading_drive_slash(raw: &str) -> &str {
    let bytes = raw.as_bytes();
    if bytes.len() >= 3
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && bytes[2] == b':'
        && (bytes.len() == 3 || bytes[3] == b'/' || bytes[3] == b'\\')
    {
        &raw[1..]
    } else {
        raw
    }
}

/// 若绝对路径在本地已存在（目录或文件），规范化为无 `\\?\` 前缀的目录路径；否则保留原文本交由 daemon 或前端处理。
fn normalize_deep_link_path(raw: &str) -> String {
    let trimmed = strip_leading_drive_slash(raw.trim());
    if trimmed.is_empty() {
        return String::new();
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        if let Some(existing) = existing_target_directory(path) {
            return existing;
        }
    }
    trimmed.to_string()
}

/// 解析 `aiwb://` 深层链接：
/// - `aiwb://open?path=<dir>&prompt=<optional_draft>`（兼容 `dir=<dir>` 与 `aiwb://open/<encoded_path>`）
/// - `aiwb://new?prompt=<draft>&project=<optional_dir_or_name>`
pub fn parse_deep_link_url(raw: &str) -> Option<LaunchIntent> {
    let trimmed = raw.trim();
    let url = Url::parse(trimmed).ok()?;
    if !url.scheme().eq_ignore_ascii_case("aiwb") {
        return None;
    }

    let (route, rest_path) = match url.host_str().filter(|host| !host.is_empty()) {
        Some(host) => (
            host.to_ascii_lowercase(),
            url.path().strip_prefix('/').unwrap_or(url.path()),
        ),
        None => {
            let without_first = url.path().strip_prefix('/').unwrap_or(url.path());
            let clean = without_first.trim_start_matches('/');
            match clean.split_once('/') {
                Some((first, rest)) => (first.to_ascii_lowercase(), rest),
                None => (clean.to_ascii_lowercase(), ""),
            }
        }
    };

    let form_params: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let raw_params = parse_raw_query_params(url.query());

    let lookup_form_param = |name: &str| -> Option<String> {
        form_params
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };

    // 路径参数优先采用标准 query_pairs 解析结果（兼容 `+` 与 `%20` 表示空格）；
    // 仅当标准解析后的路径不存在，且未将 `+` 转为空格的绝对路径真实存在于磁盘上时（如 `/.../cpp+plus`），才回退保留字面 `+`。
    let lookup_path_param = |names: &[&str]| -> Option<String> {
        for name in names {
            if let Some((_, form_val)) = form_params.iter().find(|(k, _)| k == name) {
                let clean_form = strip_leading_drive_slash(form_val.trim());
                if clean_form.is_empty() {
                    continue;
                }
                if !Path::new(clean_form).exists() {
                    if let Some((_, raw_val)) = raw_params.iter().find(|(k, _)| k == name) {
                        let clean_raw = strip_leading_drive_slash(raw_val.trim());
                        if clean_raw.contains('+')
                            && Path::new(clean_raw).is_absolute()
                            && Path::new(clean_raw).exists()
                        {
                            return Some(clean_raw.to_string());
                        }
                    }
                }
                return Some(clean_form.to_string());
            }
        }
        None
    };

    // prompt 使用标准 URLSearchParams / query_pairs 语义（兼容 `+` 与 `%20`），不做隐式删改以便前端统计隐藏字符数。
    let prompt_param = form_params
        .iter()
        .find(|(k, _)| k == "prompt")
        .map(|(_, v)| v.clone())
        .filter(|v| !v.is_empty());

    match route.as_str() {
        "open" => {
            let raw_dir = lookup_path_param(&["path", "dir"]).or_else(|| {
                let decoded = percent_decode_utf8(rest_path);
                let clean = decoded.trim();
                (!clean.is_empty()).then(|| clean.to_string())
            });
            match raw_dir {
                Some(dir) => Some(LaunchIntent::Directory {
                    path: normalize_deep_link_path(&dir),
                    prompt: prompt_param,
                }),
                None => prompt_param.map(|prompt| LaunchIntent::NewPrompt {
                    prompt,
                    project: None,
                }),
            }
        }
        "new" => {
            // `project` 可能是显示名称或路径：直接使用标准查询参数解析结果，且仅当为绝对路径时才做本机目录规范化，
            // 避免按显示名称匹配项目时受进程当前工作目录布局影响。
            let project = lookup_form_param("project")
                .map(|value| normalize_deep_link_path(&value))
                .or_else(|| {
                    lookup_path_param(&["path", "dir"]).map(|value| normalize_deep_link_path(&value))
                });
            let prompt = prompt_param.unwrap_or_default();
            Some(LaunchIntent::NewPrompt { prompt, project })
        }
        _ => None,
    }
}

fn parse_raw_query_params(query: Option<&str>) -> Vec<(String, String)> {
    let Some(query) = query else {
        return Vec::new();
    };
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| match pair.split_once('=') {
            Some((k, v)) => (percent_decode_utf8(k), percent_decode_utf8(v)),
            None => (percent_decode_utf8(pair), String::new()),
        })
        .collect()
}

fn percent_decode_utf8(input: &str) -> String {
    percent_decode_str(input).decode_utf8_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_open_deep_link_query_and_encoded_path_variants() {
        assert_eq!(
            parse_deep_link_url("aiwb://open?path=G%3A%5Cwork%5Crepo&prompt=review+diff"),
            Some(LaunchIntent::Directory {
                path: r"G:\work\repo".into(),
                prompt: Some("review diff".into()),
            })
        );
        assert_eq!(
            parse_deep_link_url("aiwb://open?dir=C%3A%2Fprojects%2Fcpp%2B%2B"),
            Some(LaunchIntent::Directory {
                path: "C:/projects/cpp++".into(),
                prompt: None,
            })
        );
        assert_eq!(
            parse_deep_link_url("aiwb://open/G%3A%2Fmy%20repo?prompt=%E4%BD%A0%E5%A5%BD"),
            Some(LaunchIntent::Directory {
                path: "G:/my repo".into(),
                prompt: Some("你好".into()),
            })
        );
        assert_eq!(
            parse_deep_link_url("aiwb:///open?path=%2FUsers%2Fdev%2Fapp"),
            Some(LaunchIntent::Directory {
                path: "/Users/dev/app".into(),
                prompt: None,
            })
        );
        assert_eq!(
            parse_deep_link_url("aiwb://open?path=/G:/work/repo"),
            Some(LaunchIntent::Directory {
                path: "G:/work/repo".into(),
                prompt: None,
            })
        );
    }

    #[test]
    fn parses_new_deep_link_and_rejects_foreign_schemes() {
        assert_eq!(
            parse_deep_link_url("aiwb://new?prompt=fix%20tests&project=ai-workbench"),
            Some(LaunchIntent::NewPrompt {
                prompt: "fix tests".into(),
                project: Some("ai-workbench".into()),
            })
        );
        assert_eq!(
            parse_deep_link_url("aiwb://new?project=My+Project&prompt=hi"),
            Some(LaunchIntent::NewPrompt {
                prompt: "hi".into(),
                project: Some("My Project".into()),
            })
        );
        assert_eq!(
            parse_deep_link_url("aiwb://new?project=C%2B%2B+App&prompt=hi"),
            Some(LaunchIntent::NewPrompt {
                prompt: "hi".into(),
                project: Some("C++ App".into()),
            })
        );
        // 即使当前目录下存在名为 `crates` 的真实子目录，按名称传 `project=crates` 也不应被误改写成相对路径展开结果。
        assert_eq!(
            parse_deep_link_url("aiwb://new?project=crates&prompt=hi"),
            Some(LaunchIntent::NewPrompt {
                prompt: "hi".into(),
                project: Some("crates".into()),
            })
        );
        assert_eq!(parse_deep_link_url("https://example.com/open?path=foo"), None);
        assert_eq!(parse_deep_link_url("aiwb://unknown-route?foo=bar"), None);
    }

    #[test]
    fn resolves_cli_relative_dirs_file_parents_and_ignores_flags() {
        let base = std::env::temp_dir().join(format!("aiwb-launch-test-{}", uuid::Uuid::new_v4()));
        let sub = base.join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        let file = sub.join("README.md");
        std::fs::write(&file, "hi").unwrap();

        let argv = vec![
            "ai-workbench.exe".to_string(),
            "--flag".to_string(),
            "-v".to_string(),
            ".".to_string(),
            "nested/README.md".to_string(),
            "non-existent-arg".to_string(),
            "aiwb://new?prompt=hello".to_string(),
        ];
        let intents = parse_cli_args(&argv, Some(&base));
        let expected_base = strip_verbatim_prefix(&base.canonicalize().unwrap().to_string_lossy());
        let expected_sub = strip_verbatim_prefix(&sub.canonicalize().unwrap().to_string_lossy());

        assert_eq!(
            intents,
            vec![
                LaunchIntent::Directory {
                    path: expected_base,
                    prompt: None,
                },
                LaunchIntent::Directory {
                    path: expected_sub,
                    prompt: None,
                },
                LaunchIntent::NewPrompt {
                    prompt: "hello".into(),
                    project: None,
                },
            ]
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn decodes_plus_in_leading_slash_drive_path_when_space_dir_exists() {
        let base = std::env::temp_dir().join(format!("aiwb-launch-plus-{}", uuid::Uuid::new_v4()));
        let spaced = base.join("my repo");
        let literal_plus = base.join("cpp+plus");
        std::fs::create_dir_all(&spaced).unwrap();
        std::fs::create_dir_all(&literal_plus).unwrap();

        let spaced_forward = spaced.to_string_lossy().replace('\\', "/");
        let plus_encoded = spaced_forward.replace(' ', "+");
        let url_path = if cfg!(windows) {
            format!("aiwb://open?path=/{plus_encoded}&prompt=hi")
        } else {
            format!("aiwb://open?path={plus_encoded}&prompt=hi")
        };
        let expected_spaced =
            strip_verbatim_prefix(&spaced.canonicalize().unwrap().to_string_lossy());
        assert_eq!(
            parse_deep_link_url(&url_path),
            Some(LaunchIntent::Directory {
                path: expected_spaced,
                prompt: Some("hi".into()),
            })
        );

        let literal_forward = literal_plus.to_string_lossy().replace('\\', "/");
        let literal_url = if cfg!(windows) {
            format!("aiwb://open?path=/{literal_forward}")
        } else {
            format!("aiwb://open?path={literal_forward}")
        };
        let expected_literal =
            strip_verbatim_prefix(&literal_plus.canonicalize().unwrap().to_string_lossy());
        assert_eq!(
            parse_deep_link_url(&literal_url),
            Some(LaunchIntent::Directory {
                path: expected_literal,
                prompt: None,
            })
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn parses_open_path_preserving_ampersands_pluses_and_percent_escapes() {
        assert_eq!(
            parse_deep_link_url("aiwb://open/G:/R%20D&A"),
            Some(LaunchIntent::Directory {
                path: "G:/R D&A".into(),
                prompt: None,
            })
        );
        assert_eq!(
            parse_deep_link_url("aiwb://open/G:/R%20D&A?prompt=fix+bug"),
            Some(LaunchIntent::Directory {
                path: "G:/R D&A".into(),
                prompt: Some("fix bug".into()),
            })
        );
        assert_eq!(
            parse_deep_link_url("aiwb:///open/G:/C++%20&%20Rust"),
            Some(LaunchIntent::Directory {
                path: "G:/C++ & Rust".into(),
                prompt: None,
            })
        );
        assert_eq!(
            parse_deep_link_url("aiwb://open/G:/100%25%20%E4%B8%AD%E6%96%87&x=1"),
            Some(LaunchIntent::Directory {
                path: "G:/100% 中文&x=1".into(),
                prompt: None,
            })
        );
        assert_eq!(
            parse_deep_link_url("aiwb://open/G:/foo%ZZ&bar"),
            Some(LaunchIntent::Directory {
                path: "G:/foo%ZZ&bar".into(),
                prompt: None,
            })
        );

        let base = std::env::temp_dir().join(format!("aiwb-launch-amp-{}", uuid::Uuid::new_v4()));
        let amp_dir = base.join("R D&A");
        std::fs::create_dir_all(&amp_dir).unwrap();
        let forward = amp_dir.to_string_lossy().replace('\\', "/").replace(' ', "%20");
        let url = format!("aiwb://open/{forward}");
        let expected = strip_verbatim_prefix(&amp_dir.canonicalize().unwrap().to_string_lossy());
        assert_eq!(
            parse_deep_link_url(&url),
            Some(LaunchIntent::Directory {
                path: expected,
                prompt: None,
            })
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
