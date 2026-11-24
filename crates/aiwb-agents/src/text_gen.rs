//! 独立于主会话的无痕轻量文本生成实现（CLI 禁插件/MCP/Hooks 模式）。

use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use aiwb_proc::{apply_utf8_env, decode_child_bytes, hide_console};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::timeout;

use crate::instance::InstanceOverlay;
use crate::AgentError;

const TEXT_GEN_TIMEOUT: Duration = Duration::from_secs(60);
/// Windows `CreateProcessW` 整个命令行上限为 32,767 UTF-16 码元；对走 `-p <prompt>` 参数传递的 CLI 裁剪安全上限。
const MAX_ARGV_PROMPT_CHARS: usize = 12_000;

struct TempScratchDir(PathBuf);

impl TempScratchDir {
    fn new(prefix: &str) -> Result<Self, AgentError> {
        let dir = std::env::temp_dir().join(format!(
            "aiwb-{prefix}-textgen-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).map_err(|e| AgentError::Runtime(e.to_string()))?;
        Ok(Self(dir))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct StatelessCliOutput {
    status: ExitStatus,
    stdout: String,
    stderr: String,
}

async fn run_stateless_cli(
    mut command: Command,
    label: &str,
    display_bin: &Path,
    workdir: &Path,
    stdin_payload: Option<&[u8]>,
) -> Result<StatelessCliOutput, AgentError> {
    command
        .current_dir(workdir)
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    apply_utf8_env(&mut command);
    hide_console(&mut command);

    let mut child = command.spawn().map_err(|e| {
        AgentError::Runtime(format!(
            "无法启动 {label} 轻量生成（{}）：{e}",
            display_bin.display()
        ))
    })?;
    if let Some(payload) = stdin_payload {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(payload).await;
            let _ = stdin.shutdown().await;
        }
    }
    let output = timeout(TEXT_GEN_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| AgentError::Runtime(format!("{label} 轻量文本生成超时")))?
        .map_err(|e| AgentError::Runtime(format!("等待 {label} 输出失败：{e}")))?;

    Ok(StatelessCliOutput {
        status: output.status,
        stdout: decode_child_bytes(&output.stdout).trim().to_string(),
        stderr: decode_child_bytes(&output.stderr).trim().to_string(),
    })
}

fn truncate_argv_prompt(prompt: &str) -> &str {
    match prompt.char_indices().nth(MAX_ARGV_PROMPT_CHARS) {
        Some((byte_idx, _)) => &prompt[..byte_idx],
        None => prompt,
    }
}

fn format_codex_mcp_disable_arg(name: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    let key = if name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        name.to_string()
    } else {
        serde_json::to_string(name).ok()?
    };
    Some(format!("mcp_servers.{key}.enabled=false"))
}

/// 从目标实例 `config.toml` 直接解析已配置的 MCP 服务器名，不额外派生 `codex mcp list` 子进程。
fn codex_configured_mcp_names(codex_home: Option<&Path>) -> Vec<String> {
    let Some(path) = codex_home.map(|h| h.join("config.toml")).filter(|p| p.is_file()) else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(doc) = raw.parse::<toml_edit::Document>() else {
        return Vec::new();
    };
    doc.get("mcp_servers")
        .and_then(toml_edit::Item::as_table_like)
        .map(|tbl| tbl.iter().map(|(k, _)| k.to_string()).collect())
        .unwrap_or_default()
}

/// Codex 无痕文本生成：`codex exec --ephemeral --skip-git-repo-check --ignore-rules` 并关掉 MCP/插件/Apps/Hooks。
pub async fn codex_generate_text(
    overlay: &InstanceOverlay,
    prompt: &str,
    model: Option<&str>,
    cwd: Option<&Path>,
) -> Result<String, AgentError> {
    let bin = crate::codex::resolve_bin_for(overlay)?;
    let codex_home =
        crate::codex::shadow_home::effective_codex_home(overlay).map_err(AgentError::Runtime)?;

    let scratch = TempScratchDir::new("codex")?;
    let out_file = scratch.path().join("last_message.txt");
    let workdir = cwd.filter(|p| p.is_dir()).unwrap_or_else(|| scratch.path());

    let mcp_names = codex_configured_mcp_names(codex_home.as_deref());

    let mut command = Command::new(&bin);
    command.arg("exec");
    command.args(&overlay.launch_args);
    for name in &mcp_names {
        if let Some(override_kv) = format_codex_mcp_disable_arg(name) {
            command.args(["-c", &override_kv]);
        }
    }
    command.args([
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-rules",
        "--color",
        "never",
        "-s",
        "read-only",
        "-c",
        "features.plugins=false",
        "-c",
        "features.apps=false",
        "-c",
        "features.hooks=false",
        "-c",
        "features.codex_hooks=false",
        "-c",
        "model_reasoning_effort=\"low\"",
    ]);
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        command.args(["-m", m]);
    }
    command.arg("-o").arg(&out_file).arg("-");
    crate::codex::apply_instance_env(&mut command, overlay, codex_home.as_deref());

    let output = run_stateless_cli(
        command,
        "Codex",
        &bin,
        workdir,
        Some(prompt.as_bytes()),
    )
    .await?;

    if let Ok(text) = std::fs::read_to_string(&out_file) {
        let trimmed = text.trim().to_string();
        if !trimmed.is_empty() {
            return Ok(trimmed);
        }
    }
    if output.status.success() && !output.stdout.is_empty() {
        return Ok(output.stdout);
    }
    Err(AgentError::Runtime(if output.stderr.is_empty() {
        format!("Codex 轻量生成失败（退出码 {:?}）", output.status.code())
    } else {
        output.stderr
    }))
}

fn has_claude_managed_mcp_config() -> bool {
    #[cfg(target_os = "windows")]
    let path = Path::new(r"C:\Program Files\ClaudeCode\managed-mcp.json");
    #[cfg(target_os = "macos")]
    let path = Path::new("/Library/Application Support/ClaudeCode/managed-mcp.json");
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let path = Path::new("/etc/claude-code/managed-mcp.json");
    path.is_file()
}

/// Claude 无痕文本生成：`claude -p --no-session-persistence --tools "" --disable-slash-commands` 禁全部 MCP 与 Hooks。
pub async fn claude_generate_text(
    overlay: &InstanceOverlay,
    prompt: &str,
    model: Option<&str>,
    _cwd: Option<&Path>,
) -> Result<String, AgentError> {
    let bin = crate::claude::resolve_bin_for(overlay)?;
    let scratch = TempScratchDir::new("claude")?;

    let res = run_claude_once(&bin, overlay, prompt, model, scratch.path(), true).await;
    match res {
        Err(AgentError::Runtime(ref msg)) if msg.contains("--no-session-persistence") => {
            run_claude_once(&bin, overlay, prompt, model, scratch.path(), false).await
        }
        other => other,
    }
}

async fn run_claude_once(
    bin: &Path,
    overlay: &InstanceOverlay,
    prompt: &str,
    model: Option<&str>,
    scratch_dir: &Path,
    no_persistence: bool,
) -> Result<String, AgentError> {
    let mut command = Command::new(bin);
    command.args(&overlay.launch_args);
    command.args([
        "-p",
        "--output-format",
        "json",
        "--tools",
        "",
        "--disable-slash-commands",
        "--permission-mode",
        "dontAsk",
        "--settings",
        r#"{"disableAllHooks":true}"#,
    ]);
    if !has_claude_managed_mcp_config() {
        command.arg("--strict-mcp-config");
    }
    if no_persistence {
        command.arg("--no-session-persistence");
    }
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        command.args(["--model", m]);
    }
    crate::claude::apply_instance_env(&mut command, overlay);

    let output = run_stateless_cli(
        command,
        "Claude",
        bin,
        scratch_dir,
        Some(prompt.as_bytes()),
    )
    .await?;

    if let Ok(val) = serde_json::from_str::<Value>(&output.stdout) {
        let items: Vec<&Value> = match &val {
            Value::Array(arr) => arr.iter().collect(),
            other => vec![other],
        };
        for item in items.iter().rev() {
            if item.get("is_error").and_then(Value::as_bool) == Some(true) {
                let err_msg = item
                    .get("result")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string)
                    .or_else(|| {
                        item.get("errors")
                            .and_then(Value::as_array)
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(Value::as_str)
                                    .filter(|s| !s.starts_with("[ede_diagnostic]"))
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .filter(|s| !s.trim().is_empty())
                    })
                    .unwrap_or_else(|| "Claude 返回错误".to_string());
                return Err(AgentError::Runtime(err_msg));
            }
            if let Some(result) = item.get("result").and_then(Value::as_str) {
                let trimmed = result.trim();
                if !trimmed.is_empty() {
                    return Ok(trimmed.to_string());
                }
            }
        }
    }

    if output.status.success() && !output.stdout.is_empty() {
        return Ok(output.stdout);
    }

    Err(AgentError::Runtime(if !output.stderr.is_empty() {
        output.stderr
    } else if !output.stdout.is_empty() {
        output.stdout
    } else {
        format!("Claude 轻量生成失败（退出码 {:?}）", output.status.code())
    }))
}

/// Cursor Agent 轻量单轮文本生成（`agent -p --output-format text`）。
pub async fn cursor_generate_text(
    overlay: &InstanceOverlay,
    prompt: &str,
    model: Option<&str>,
    _cwd: Option<&Path>,
) -> Result<String, AgentError> {
    let launcher = crate::cursor::resolve_for(overlay)?;
    let scratch = TempScratchDir::new("cursor")?;

    let capped_prompt = truncate_argv_prompt(prompt);
    let mut command = Command::new(&launcher.program);
    command.args(&launcher.prefix);
    command.args(&overlay.launch_args);
    command.args(["-p", capped_prompt, "--output-format", "text"]);
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        command.args(["--model", m]);
    }
    crate::cursor::apply_instance_env(&mut command, overlay);

    let output = run_stateless_cli(
        command,
        "Cursor Agent",
        &launcher.program,
        scratch.path(),
        None,
    )
    .await?;
    if output.status.success() && !output.stdout.is_empty() {
        return Ok(output.stdout);
    }
    Err(AgentError::Runtime(if output.stderr.is_empty() {
        format!(
            "Cursor Agent 轻量生成失败（退出码 {:?}）",
            output.status.code()
        )
    } else {
        output.stderr
    }))
}

fn parse_agy_json_payload(stdout: &str) -> Option<Value> {
    serde_json::from_str::<Value>(stdout).ok().or_else(|| {
        stdout
            .lines()
            .rev()
            .find(|line| line.trim_start().starts_with('{'))
            .and_then(|line| serde_json::from_str::<Value>(line.trim()).ok())
    })
}

fn consume_agy_json_and_cleanup(
    overlay: &InstanceOverlay,
    stdout: &str,
) -> Option<Result<String, AgentError>> {
    let payload = parse_agy_json_payload(stdout)?;
    let session_id = [
        "conversation_id",
        "session_id",
        "conversationId",
        "sessionId",
    ]
    .iter()
    .find_map(|key| payload.get(*key).and_then(Value::as_str))
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(str::to_string);

    if let Some(id) = session_id.as_deref() {
        let _ = crate::antigravity::directory::remove_for(overlay, id);
    }

    let status_failed = payload
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some_and(|s| {
            !s.eq_ignore_ascii_case("SUCCESS")
                && !s.eq_ignore_ascii_case("OK")
                && !s.eq_ignore_ascii_case("COMPLETED")
        });
    let explicit_error = payload
        .get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || payload
            .get("error")
            .is_some_and(|v| !v.is_null() && v.as_str().is_none_or(|s| !s.trim().is_empty()));

    if explicit_error || status_failed {
        let err_msg = payload
            .get("error")
            .and_then(|e| {
                e.as_str().map(str::to_string).or_else(|| {
                    e.get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
            })
            .or_else(|| {
                payload
                    .get("response")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Antigravity 轻量生成返回错误".to_string());
        return Some(Err(AgentError::Runtime(err_msg)));
    }

    let text = ["response", "result", "text"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)?;
    Some(Ok(text))
}

/// Antigravity 轻量单轮文本生成（`agy -p --disable-slash-commands --effort low --output-format json`），
/// 并在返回前自动清理生成的临时会话文件（`conversations/<id>.db` 与 `brain/<id>`）。
pub async fn agy_generate_text(
    overlay: &InstanceOverlay,
    prompt: &str,
    model: Option<&str>,
    _cwd: Option<&Path>,
) -> Result<String, AgentError> {
    let bin = crate::antigravity::resolve_bin_for(overlay)?;
    let scratch = TempScratchDir::new("agy")?;

    let capped_prompt = truncate_argv_prompt(prompt);
    let mut command = Command::new(&bin);
    command.args(&overlay.launch_args);
    command.args([
        "--disable-slash-commands",
        "--effort",
        "low",
        "--output-format",
        "json",
    ]);
    if let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) {
        command.args(["--model", m]);
    }
    command.args(["-p", capped_prompt]);
    command.envs(crate::antigravity::NO_SELF_UPDATE);
    crate::antigravity::apply_instance_env(&mut command, overlay);

    let output = run_stateless_cli(command, "Antigravity", &bin, scratch.path(), None).await?;
    if let Some(parsed) = consume_agy_json_and_cleanup(overlay, &output.stdout) {
        return parsed;
    }
    if output.status.success() && !output.stdout.is_empty() {
        return Ok(output.stdout);
    }
    Err(AgentError::Runtime(if output.stderr.is_empty() {
        format!(
            "Antigravity 轻量生成失败（退出码 {:?}）",
            output.status.code()
        )
    } else {
        output.stderr
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agy_json_output_extracts_response_and_removes_transient_session() {
        let dir = tempfile::tempdir().unwrap();
        let agy_root = dir.path().join("antigravity-cli");
        let conv_dir = agy_root.join("conversations");
        let id_a = "e90a3885-8426-4864-af73-45e89910213d";
        let id_b = "0b5c2f53-9d0e-4b6a-8a43-2b1c3d4e5f60";
        std::fs::create_dir_all(&conv_dir).unwrap();
        std::fs::create_dir_all(agy_root.join("brain").join(id_a)).unwrap();
        std::fs::write(conv_dir.join(format!("{id_a}.db")), b"sqlite").unwrap();
        std::fs::write(conv_dir.join(format!("{id_b}.db")), b"sqlite").unwrap();

        let overlay = InstanceOverlay {
            home_path: Some(dir.path().to_path_buf()),
            ..Default::default()
        };

        let raw_conv = serde_json::json!({
            "conversation_id": id_a,
            "status": "SUCCESS",
            "response": "feat/keybindings\n",
            "num_turns": 1
        })
        .to_string();
        let text = consume_agy_json_and_cleanup(&overlay, &raw_conv)
            .expect("parsed")
            .expect("ok");
        assert_eq!(text, "feat/keybindings");
        assert!(!conv_dir.join(format!("{id_a}.db")).exists());
        assert!(!agy_root.join("brain").join(id_a).exists());

        // 兼容 `session_id` 字段并在失败响应时同样清理残留会话
        let raw_err = serde_json::json!({
            "session_id": id_b,
            "status": "ERROR",
            "error": "quota exceeded"
        })
        .to_string();
        let err = consume_agy_json_and_cleanup(&overlay, &raw_err)
            .expect("parsed")
            .unwrap_err();
        assert!(err.to_string().contains("quota exceeded"));
        assert!(!conv_dir.join(format!("{id_b}.db")).exists());
    }
}
