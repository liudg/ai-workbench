//! 专用轻量文本生成服务（`pv-02`）：
//! 独立于主会话上下文，提供异步会话标题、AI 重新生成标题、语义化 Git 分支名与 Commit 说明生成。
//! 支持无痕复用已就绪 CLI（禁插件/MCP/Hooks 并优先挑轻量模型）以及可选的 OpenAI / Anthropic 兼容 HTTP API。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use aiwb_core::models::{
    effective_instance_id, is_visible_user_text, AgentCatalog, AgentInstance, AgentKind,
    GeneratedCommitMessage, SessionEventBody, TextGenHttpConfig, TextGenHttpProtocol, TextGenMode,
    TextGenSettings,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{blocking, now_millis, Scope, ServiceResult, Services};

const META_TEXT_GEN: &str = "text_gen.settings";
const HTTP_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_DIFF_CHARS: usize = 16_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegenerateTitleParam {
    pub task_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneratedTitleResult {
    pub title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerateBranchParam {
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneratedBranchResult {
    pub branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GenerateCommitParam {
    #[serde(flatten)]
    pub scope: Scope,
    #[serde(default)]
    pub diff_scope: Option<String>,
}

fn has_light_token(value: &str, keyword: &str) -> bool {
    value
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|tok| tok.eq_ignore_ascii_case(keyword))
}

fn pick_lightweight_model(catalog: Option<&AgentCatalog>) -> Option<String> {
    let models = &catalog?.models;
    if models.is_empty() {
        return None;
    }
    const LIGHT_KEYWORDS: &[&str] = &["haiku", "mini", "flash", "spark", "nano", "lite", "small"];
    for kw in LIGHT_KEYWORDS {
        if let Some(hit) = models
            .iter()
            .find(|m| has_light_token(&m.id, kw) || has_light_token(&m.label, kw))
        {
            return Some(hit.id.clone());
        }
    }
    models
        .iter()
        .find(|m| m.is_default)
        .or_else(|| models.first())
        .map(|m| m.id.clone())
}

fn is_instance_usable(
    instances: &[AgentInstance],
    runtimes: &crate::runtime::Runtimes,
    kind: AgentKind,
    inst_id: Option<&str>,
) -> bool {
    let eff = effective_instance_id(kind, inst_id);
    let is_default = eff == aiwb_core::models::default_instance_id(kind);
    let enabled = match instances.iter().find(|i| i.id == eff) {
        Some(i) => i.enabled && i.kind == kind,
        None => is_default,
    };
    enabled
        && runtimes
            .adapter_for_instance(kind, inst_id)
            .ok()
            .is_some_and(|a| a.capabilities().supports_text_generation)
}

fn select_candidate_model(
    explicit_model: Option<&str>,
    configured_instance_id: Option<&str>,
    candidate_instance_id: &str,
    catalog: Option<&AgentCatalog>,
    strict_explicit: bool,
) -> Option<String> {
    if let Some(model) = explicit_model {
        let matches_instance = configured_instance_id == Some(candidate_instance_id);
        let in_catalog = catalog.is_some_and(|cat| {
            cat.models.iter().any(|m| {
                m.id == model || (!m.resolved_model.is_empty() && m.resolved_model == model)
            })
        });
        if strict_explicit || matches_instance || in_catalog {
            return Some(model.to_string());
        }
    }
    pick_lightweight_model(catalog)
}

fn resolve_candidate_model(
    runtimes: &crate::runtime::Runtimes,
    kind: AgentKind,
    inst_id: Option<&str>,
    explicit_model: Option<&str>,
    configured_instance_id: Option<&str>,
    strict_explicit: bool,
) -> Option<String> {
    let eff_id = effective_instance_id(kind, inst_id);
    let catalog = runtimes.stored_catalog_for(kind, inst_id).ok().flatten();
    select_candidate_model(
        explicit_model,
        configured_instance_id,
        eff_id,
        catalog.as_ref(),
        strict_explicit,
    )
}

fn strip_code_fences(raw: &str) -> String {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("```") {
        let without_lang = rest
            .find('\n')
            .map(|idx| &rest[idx + 1..])
            .unwrap_or(rest);
        if let Some(end) = without_lang.rfind("```") {
            return without_lang[..end].trim().to_string();
        }
    }
    trimmed.to_string()
}

pub(crate) fn clean_generated_title(raw: &str) -> Option<String> {
    let stripped = strip_code_fences(raw);
    if let Ok(val) = serde_json::from_str::<Value>(&stripped) {
        if let Some(t) = val.get("title").and_then(Value::as_str) {
            return clean_plain_title(t);
        }
    }
    let first_line = stripped
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    clean_plain_title(first_line)
}

fn clean_plain_title(line: &str) -> Option<String> {
    let s = line
        .trim()
        .trim_start_matches(['#', '*', '-', '•'])
        .trim()
        .trim_matches(['"', '\'', '“', '”', '‘', '’', '《', '》', '`'])
        .trim_end_matches(['。', '！', '？', '.', ';', '；', ':'])
        .trim();
    if s.is_empty() {
        return None;
    }
    let clipped: String = s.chars().take(40).collect();
    Some(clipped.trim().to_string()).filter(|t| !t.is_empty())
}

pub(crate) fn clean_generated_branch(raw: &str) -> Option<String> {
    let stripped = strip_code_fences(raw);
    let candidate = if let Ok(val) = serde_json::from_str::<Value>(&stripped) {
        val.get("branch")
            .and_then(Value::as_str)
            .unwrap_or(&stripped)
            .to_string()
    } else {
        stripped
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("")
            .to_string()
    };
    let trimmed = candidate
        .trim()
        .trim_matches(['`', '"', '\''])
        .to_ascii_lowercase();
    let mut slug = String::new();
    let mut prev_dash = false;
    let mut slash_seen = false;
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            prev_dash = false;
        } else if ch == '/' && !slash_seen && !slug.is_empty() {
            slug.push('/');
            slash_seen = true;
            prev_dash = true;
        } else if matches!(ch, '-' | '_' | ' ' | '.') && !slug.is_empty() && !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_matches(['-', '/']).to_string();
    if slug.is_empty() {
        return None;
    }
    let clipped: String = slug.chars().take(52).collect();
    Some(clipped.trim_matches(['-', '/']).to_string()).filter(|b| !b.is_empty())
}

pub(crate) fn parse_generated_commit(raw: &str) -> Option<GeneratedCommitMessage> {
    let stripped = strip_code_fences(raw);
    if let Ok(val) = serde_json::from_str::<Value>(&stripped) {
        if let Some(subject) = val.get("subject").and_then(Value::as_str) {
            let subject = subject.trim().trim_matches('"').to_string();
            if !subject.is_empty() {
                let body = val
                    .get("body")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("")
                    .to_string();
                let message = if body.is_empty() {
                    subject.clone()
                } else {
                    format!("{subject}\n\n{body}")
                };
                return Some(GeneratedCommitMessage {
                    subject,
                    body,
                    message,
                });
            }
        }
    }
    let mut lines = stripped.lines();
    let subject = lines
        .by_ref()
        .map(str::trim)
        .find(|l| !l.is_empty())?
        .trim_matches(['`', '"'])
        .to_string();
    if subject.is_empty() {
        return None;
    }
    let body = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    let message = if body.is_empty() {
        subject.clone()
    } else {
        format!("{subject}\n\n{body}")
    };
    Some(GeneratedCommitMessage {
        subject,
        body,
        message,
    })
}

async fn http_generate_text(cfg: &TextGenHttpConfig, prompt: &str) -> Result<String, String> {
    let base = cfg.base_url.trim().trim_end_matches('/');
    let model = cfg.model.trim();
    if base.is_empty() {
        return Err("HTTP 文本生成未配置 Base URL".into());
    }
    if model.is_empty() {
        return Err("HTTP 文本生成未配置模型名称".into());
    }
    let client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    match cfg.protocol {
        TextGenHttpProtocol::OpenAi => {
            let url = if base.ends_with("/chat/completions") {
                base.to_string()
            } else if base.ends_with("/v1") {
                format!("{base}/chat/completions")
            } else {
                format!("{base}/v1/chat/completions")
            };
            let send_openai = |token_key: &str| {
                let mut body = json!({
                    "model": model,
                    "messages": [
                        { "role": "user", "content": prompt }
                    ],
                });
                body[token_key] = json!(512);
                let mut req = client.post(&url).json(&body);
                if !cfg.api_key.trim().is_empty() {
                    req = req.bearer_auth(cfg.api_key.trim());
                }
                req
            };
            let resp = send_openai("max_completion_tokens")
                .send()
                .await
                .map_err(|e| format!("请求 OpenAI 兼容接口失败：{e}"))?;
            let mut status = resp.status();
            let mut text = resp
                .text()
                .await
                .map_err(|e| format!("读取 HTTP 响应失败：{e}"))?;
            if status == reqwest::StatusCode::BAD_REQUEST && text.contains("max_completion_tokens")
            {
                let fallback_resp = send_openai("max_tokens")
                    .send()
                    .await
                    .map_err(|e| format!("请求 OpenAI 兼容接口失败：{e}"))?;
                status = fallback_resp.status();
                text = fallback_resp
                    .text()
                    .await
                    .map_err(|e| format!("读取 HTTP 响应失败：{e}"))?;
            }
            if !status.is_success() {
                return Err(format!("HTTP {}：{}", status.as_u16(), text));
            }
            let val: Value =
                serde_json::from_str(&text).map_err(|e| format!("解析响应 JSON 失败：{e}"))?;
            val.pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .ok_or_else(|| "OpenAI 兼容接口未返回有效文本".into())
        }
        TextGenHttpProtocol::Anthropic => {
            let url = if base.ends_with("/messages") {
                base.to_string()
            } else if base.ends_with("/v1") {
                format!("{base}/messages")
            } else {
                format!("{base}/v1/messages")
            };
            let mut req = client
                .post(&url)
                .header("anthropic-version", "2023-06-01")
                .json(&json!({
                    "model": model,
                    "max_tokens": 512,
                    "messages": [
                        { "role": "user", "content": prompt }
                    ]
                }));
            if !cfg.api_key.trim().is_empty() {
                req = req
                    .header("x-api-key", cfg.api_key.trim())
                    .bearer_auth(cfg.api_key.trim());
            }
            let resp = req
                .send()
                .await
                .map_err(|e| format!("请求 Anthropic 兼容接口失败：{e}"))?;
            let status = resp.status();
            let text = resp
                .text()
                .await
                .map_err(|e| format!("读取 HTTP 响应失败：{e}"))?;
            if !status.is_success() {
                return Err(format!("HTTP {}：{}", status.as_u16(), text));
            }
            let val: Value =
                serde_json::from_str(&text).map_err(|e| format!("解析响应 JSON 失败：{e}"))?;
            let joined = val
                .get("content")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|b| b.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            let trimmed = joined.trim();
            if trimmed.is_empty() {
                Err("Anthropic 兼容接口未返回有效文本".into())
            } else {
                Ok(trimmed.to_string())
            }
        }
    }
}

async fn generate_raw_text_with(
    store: &aiwb_store::Store,
    runtimes: &crate::runtime::Runtimes,
    prompt: &str,
    preferred: Option<(AgentKind, Option<String>)>,
    cwd: Option<&Path>,
) -> ServiceResult<String> {
    let settings = store
        .meta(META_TEXT_GEN)
        .map_err(|e| e.to_string())?
        .and_then(|s| serde_json::from_str::<TextGenSettings>(&s).ok())
        .unwrap_or_default();
    let configured_instance_id = settings
        .instance_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let explicit_model = settings
        .model
        .as_deref()
        .map(str::trim)
        .filter(|m| !m.is_empty());

    match settings.mode {
        TextGenMode::Http => {
            let http = settings
                .http
                .as_ref()
                .ok_or_else(|| "尚未配置 HTTP 文本生成接口".to_string())?;
            http_generate_text(http, prompt).await
        }
        TextGenMode::Cli => {
            let instances = store.list_agent_instances().map_err(|e| e.to_string())?;
            let target = if let Some(id) = configured_instance_id {
                let inst = instances
                    .iter()
                    .find(|inst| inst.id == id)
                    .ok_or_else(|| format!("指定的文本生成实例 {id} 不存在"))?;
                if !inst.enabled {
                    return Err(format!("指定的文本生成实例 {} 已停用", inst.display_name));
                }
                let adapter = runtimes.adapter_for_instance(inst.kind, Some(&inst.id))?;
                if !adapter.capabilities().supports_text_generation {
                    return Err(format!("{} 不支持轻量文本生成", adapter.display_name()));
                }
                (inst.kind, Some(inst.id.clone()))
            } else if let Some(pref) = preferred
                .as_ref()
                .filter(|(k, id)| is_instance_usable(&instances, runtimes, *k, id.as_deref()))
            {
                pref.clone()
            } else {
                instances
                    .iter()
                    .find(|inst| is_instance_usable(&instances, runtimes, inst.kind, Some(&inst.id)))
                    .map(|inst| (inst.kind, Some(inst.id.clone())))
                    .ok_or_else(|| "没有启用且支持轻量文本生成的 Agent 实例".to_string())?
            };
            let adapter = runtimes.adapter_for_instance(target.0, target.1.as_deref())?;
            let chosen_model = resolve_candidate_model(
                runtimes,
                target.0,
                target.1.as_deref(),
                explicit_model,
                configured_instance_id,
                true,
            );
            adapter
                .generate_text(prompt, chosen_model.as_deref(), cwd)
                .await
                .map_err(|e| e.to_string())
        }
        TextGenMode::Auto => {
            let instances = store.list_agent_instances().unwrap_or_default();
            let mut candidates: Vec<(AgentKind, Option<String>)> = Vec::new();
            let mut push_candidate = |kind: AgentKind, inst_id: Option<String>| {
                if !is_instance_usable(&instances, runtimes, kind, inst_id.as_deref()) {
                    return;
                }
                let eff = effective_instance_id(kind, inst_id.as_deref());
                if !candidates
                    .iter()
                    .any(|(k, id)| effective_instance_id(*k, id.as_deref()) == eff)
                {
                    candidates.push((kind, Some(eff.to_string())));
                }
            };

            if let Some(id) = configured_instance_id {
                if let Ok(Some(inst)) = store.agent_instance(id) {
                    push_candidate(inst.kind, Some(inst.id));
                }
            }
            if let Some((kind, inst_id)) = preferred {
                push_candidate(kind, inst_id);
            }
            if !instances.is_empty() {
                for inst in &instances {
                    push_candidate(inst.kind, Some(inst.id.clone()));
                }
            } else {
                for kind in AgentKind::all() {
                    push_candidate(kind, None);
                }
            }

            let mut last_err = String::from("没有可用的 CLI 轻量生成通道");
            for (kind, inst_id) in candidates {
                let Ok(adapter) = runtimes.adapter_for_instance(kind, inst_id.as_deref()) else {
                    continue;
                };
                if adapter.detect().await.is_err() {
                    continue;
                }
                let model = resolve_candidate_model(
                    runtimes,
                    kind,
                    inst_id.as_deref(),
                    explicit_model,
                    configured_instance_id,
                    false,
                );
                match adapter.generate_text(prompt, model.as_deref(), cwd).await {
                    Ok(text) if !text.trim().is_empty() => return Ok(text),
                    Ok(_) => {}
                    Err(err) => last_err = err.to_string(),
                }
            }
            Err(last_err)
        }
    }
}

impl Services {
    fn load_raw_text_gen_settings(&self) -> ServiceResult<TextGenSettings> {
        let raw = self.store.meta(META_TEXT_GEN).map_err(|e| e.to_string())?;
        Ok(raw
            .and_then(|s| serde_json::from_str::<TextGenSettings>(&s).ok())
            .unwrap_or_default())
    }

    pub(crate) fn text_gen_settings(&self) -> ServiceResult<TextGenSettings> {
        Ok(self.load_raw_text_gen_settings()?.redacted())
    }

    pub(crate) fn set_text_gen_settings(
        &self,
        mut incoming: TextGenSettings,
    ) -> ServiceResult<TextGenSettings> {
        let existing = self.load_raw_text_gen_settings()?;
        incoming.merge_secrets(Some(&existing));
        let raw = serde_json::to_string(&incoming).map_err(|e| e.to_string())?;
        self.store
            .set_meta(META_TEXT_GEN, &raw)
            .map_err(|e| e.to_string())?;
        Ok(incoming.redacted())
    }

    pub(crate) async fn generate_raw_text(
        &self,
        prompt: &str,
        preferred: Option<(AgentKind, Option<String>)>,
        cwd: Option<&Path>,
    ) -> ServiceResult<String> {
        generate_raw_text_with(&self.store, &self.runtimes, prompt, preferred, cwd).await
    }

    /// 异步为新会话自动生成简短语义标题；若用户已手工改名则绝不覆盖。
    pub(crate) fn spawn_auto_title(
        &self,
        task_id: String,
        prompt_seed: String,
        agent: AgentKind,
        instance_id: Option<String>,
    ) {
        let trimmed = prompt_seed.trim();
        if !is_visible_user_text(trimmed) {
            return;
        }
        let Ok(settings) = self.load_raw_text_gen_settings() else {
            return;
        };
        if !settings.auto_title {
            return;
        }
        if self
            .store
            .is_task_title_customized(&task_id)
            .unwrap_or(true)
        {
            return;
        }

        let store = Arc::clone(&self.store);
        let runtimes = Arc::clone(&self.runtimes);
        let seed_excerpt: String = trimmed.chars().take(1_200).collect();
        tokio::spawn(async move {
            let prompt = format!(
                "Generate a concise, specific title for a coding/chat session based on the user's message below.\n\
Rules:\n\
- Use the SAME language as the user's message (Chinese if Chinese, English if English).\n\
- Keep it within 6-18 Chinese characters or 3-7 words.\n\
- Output ONLY the plain title text on a single line, with NO quotes, NO markdown, NO trailing punctuation.\n\n\
<user_message>\n{seed_excerpt}\n</user_message>"
            );
            let Ok(raw) =
                generate_raw_text_with(&store, &runtimes, &prompt, Some((agent, instance_id)), None)
                    .await
            else {
                return;
            };
            let Some(title) = clean_generated_title(&raw) else {
                return;
            };
            if store.is_task_title_customized(&task_id).unwrap_or(true) {
                return;
            }
            if store
                .set_task_auto_title(&task_id, &title)
                .unwrap_or(false)
            {
                let _ = runtimes.publish_tasks();
            }
        });
    }

    /// 显式重新生成某个任务的会话标题（右键菜单「AI 重新生成标题」）。
    pub(crate) async fn regenerate_task_title(
        &self,
        params: RegenerateTitleParam,
    ) -> ServiceResult<GeneratedTitleResult> {
        let task = self.load_task(&params.task_id)?;
        let sessions = self
            .store
            .task_sessions(&task.id)
            .map_err(|e| e.to_string())?;
        let preferred = sessions
            .last()
            .map(|s| (s.agent, s.instance_id.clone()));

        let mut snippets = Vec::new();
        for s in &sessions {
            let events = self.store.events_since(&s.id, 0).map_err(|e| e.to_string())?;
            for item in events {
                match item.event.body {
                    SessionEventBody::UserMessage {
                        text, sender: None, ..
                    } if !text.trim().is_empty() => {
                        let clipped: String = text.trim().chars().take(400).collect();
                        snippets.push(format!("User: {clipped}"));
                    }
                    SessionEventBody::AgentMessage { text, .. } if !text.trim().is_empty() => {
                        let clipped: String = text.trim().chars().take(300).collect();
                        snippets.push(format!("Assistant: {clipped}"));
                    }
                    _ => {}
                }
                if snippets.len() >= 6 {
                    break;
                }
            }
            if snippets.len() >= 6 {
                break;
            }
        }
        if snippets.is_empty() && !task.title.trim().is_empty() {
            snippets.push(format!("User: {}", task.title.trim()));
        }
        if snippets.is_empty() {
            return Err("当前会话还没有可用于生成标题的消息内容".into());
        }

        let context = snippets.join("\n\n");
        let prompt = format!(
            "Summarize the conversation below into a concise, descriptive session title.\n\
Rules:\n\
- Match the primary language used by the user.\n\
- 6-18 Chinese characters or 3-7 words.\n\
- Output ONLY the plain title text on a single line (no quotes, no markdown, no period).\n\n\
<conversation>\n{context}\n</conversation>"
        );
        let raw = self.generate_raw_text(&prompt, preferred, None).await?;
        let title = clean_generated_title(&raw)
            .ok_or_else(|| "未能解析出有效的会话标题".to_string())?;
        self.store
            .set_task_title_with_flag(&task.id, &title, false, now_millis())
            .map_err(|e| e.to_string())?;
        self.runtimes.publish_tasks()?;
        Ok(GeneratedTitleResult { title })
    }

    /// 生成符合 Git 规范的语义化英文短分支名（如 `feat/terminal-links`）。
    pub(crate) async fn generate_branch_name(
        &self,
        params: GenerateBranchParam,
    ) -> ServiceResult<GeneratedBranchResult> {
        let mut seed = params.prompt.trim().to_string();
        let mut preferred = None;
        let mut resolved_cwd: Option<PathBuf> = None;
        if let Some(task_id) = params.task_id.as_deref() {
            if let Ok(cwd) = self.runtimes.workdir_of_task(task_id) {
                resolved_cwd = Some(PathBuf::from(cwd));
            }
            if let Ok(task) = self.load_task(task_id) {
                if seed.is_empty() {
                    seed = task.title.clone();
                }
                if let Ok(sessions) = self.store.task_sessions(&task.id) {
                    preferred = sessions.last().map(|s| (s.agent, s.instance_id.clone()));
                    if seed.chars().count() < 20 {
                        for s in &sessions {
                            if let Ok(events) = self.store.events_since(&s.id, 0) {
                                if let Some(first_user) = events.into_iter().find_map(|e| match e.event.body {
                                    SessionEventBody::UserMessage { text, sender: None, .. }
                                        if !text.trim().is_empty() =>
                                    {
                                        Some(text)
                                    }
                                    _ => None,
                                }) {
                                    seed = format!("{seed}\n{first_user}");
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
        if resolved_cwd.is_none() {
            if let Some(pid) = params.project_id.as_deref().filter(|s| !s.trim().is_empty()) {
                resolved_cwd = self.project_path(Some(pid)).ok().flatten();
            }
        }
        if seed.trim().is_empty() {
            return Err("请先提供任务描述或会话上下文".into());
        }
        let excerpt: String = seed.chars().take(1_000).collect();
        let prompt = format!(
            "Generate a short, idiomatic Git branch name in English kebab-case for the task below.\n\
Rules:\n\
- Use a conventional prefix such as `feat/`, `fix/`, `refactor/`, `docs/`, or `chore/`.\n\
- ASCII lowercase letters, digits, hyphens `-`, and at most one `/`.\n\
- Maximum 40 characters total.\n\
- Output ONLY the branch name on a single line, with NO backticks, NO quotes, NO explanation.\n\n\
<task>\n{excerpt}\n</task>"
        );
        let raw = self
            .generate_raw_text(&prompt, preferred, resolved_cwd.as_deref())
            .await?;
        let branch = clean_generated_branch(&raw)
            .ok_or_else(|| "未能生成合法的分支名".to_string())?;
        Ok(GeneratedBranchResult { branch })
    }

    /// 读取当前工作区 Diff 与最近提交风格，生成结构化 Commit 说明。
    pub(crate) async fn generate_commit_message(
        &self,
        params: GenerateCommitParam,
    ) -> ServiceResult<GeneratedCommitMessage> {
        let root = self.scope_dir(&params.scope)?;
        let preferred = params
            .scope
            .session_id
            .as_deref()
            .and_then(|sid| self.store.session(sid).ok().flatten())
            .map(|s| (s.agent, s.instance_id));

        let requested_scope = params
            .diff_scope
            .as_deref()
            .filter(|s| matches!(*s, "staged" | "unstaged" | "uncommitted"))
            .unwrap_or("uncommitted")
            .to_string();

        let root_for_diff = root.clone();
        let (diff_text, recent_commits) = blocking(move || -> ServiceResult<(String, Vec<String>)> {
            let mut diff = aiwb_git::git_diff_text(&root_for_diff, &requested_scope, false)?;
            if diff.trim().is_empty() && requested_scope != "uncommitted" {
                diff = aiwb_git::git_diff_text(&root_for_diff, "uncommitted", false)?;
            }
            let recent = aiwb_git::recent_commit_subjects(&root_for_diff, 5);
            Ok((diff, recent))
        })
        .await??;

        if diff_text.trim().is_empty() {
            return Err("当前工作区没有可生成提交说明的变更".into());
        }

        let truncated_diff: String = diff_text.chars().take(MAX_DIFF_CHARS).collect();
        let was_truncated = diff_text.chars().count() > MAX_DIFF_CHARS;
        let history_hint = if recent_commits.is_empty() {
            String::from("(none)")
        } else {
            recent_commits.join("\n")
        };

        let prompt = format!(
            "Write a clear, accurate Git commit message for the diff below, matching the style and language of the repository's recent commits (default to Conventional Commits).\n\
Return ONLY a JSON object with keys `\"subject\"` (single line <= 72 chars) and `\"body\"` (optional concise bullet points, or empty string `\"\"`), with no markdown fences.\n\n\
<recent_commits>\n{history_hint}\n</recent_commits>\n\n\
<diff truncated=\"{was_truncated}\">\n{truncated_diff}\n</diff>"
        );

        let raw = self
            .generate_raw_text(&prompt, preferred, Some(&root))
            .await?;
        parse_generated_commit(&raw).ok_or_else(|| "未能解析生成的提交说明".into())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use aiwb_agents::{AgentAdapter, AgentError, AgentSession, EventSink, SessionContext};
    use aiwb_core::models::{AgentCapabilities, AgentModelOption};
    use aiwb_core::DaemonInfo;
    use aiwb_store::Store;
    use async_trait::async_trait;

    use super::*;

    fn model_opt(id: &str, label: &str, is_default: bool) -> AgentModelOption {
        AgentModelOption {
            id: id.to_string(),
            label: label.to_string(),
            description: String::new(),
            is_default,
            default_effort: String::new(),
            efforts: Vec::new(),
            show_in_picker: true,
            service_tiers: Vec::new(),
            default_service_tier: None,
            resolved_model: String::new(),
        }
    }

    fn catalog_with_models(models: Vec<AgentModelOption>) -> AgentCatalog {
        let mut cat = AgentCatalog::empty();
        cat.models = models;
        cat
    }

    #[test]
    fn cleans_titles_branches_and_commits() {
        assert_eq!(
            clean_generated_title("\"修复终端右键菜单与选区引用。\"\n多余说明").as_deref(),
            Some("修复终端右键菜单与选区引用")
        );
        assert_eq!(
            clean_generated_branch("`Feat/Terminal Context Chip!`").as_deref(),
            Some("feat/terminal-context-chip")
        );
        let parsed = parse_generated_commit(
            "```json\n{\"subject\":\"feat(terminal): add selection context chip\",\"body\":\"- wire xterm selection\\n- add right-click menu\"}\n```",
        )
        .unwrap();
        assert_eq!(parsed.subject, "feat(terminal): add selection context chip");
        assert!(parsed.message.contains("- wire xterm selection"));
    }

    #[test]
    fn pick_lightweight_model_matches_delimited_tokens_not_gemini_or_minimax_substrings() {
        let gemini_cat = catalog_with_models(vec![
            model_opt("gemini-3.1-pro", "Gemini 3.1 Pro", true),
            model_opt("minimax-m2.5", "MiniMax M2.5", false),
            model_opt("gemini-2.5-flash", "Gemini 2.5 Flash", false),
        ]);
        assert_eq!(
            pick_lightweight_model(Some(&gemini_cat)).as_deref(),
            Some("gemini-2.5-flash")
        );

        let no_light_cat = catalog_with_models(vec![
            model_opt("gemini-3.1-pro", "Gemini 3.1 Pro", false),
            model_opt("minimax-m2.5", "MiniMax M2.5", true),
        ]);
        assert_eq!(
            pick_lightweight_model(Some(&no_light_cat)).as_deref(),
            Some("minimax-m2.5")
        );
    }

    #[tokio::test]
    async fn auto_mode_does_not_leak_explicit_model_across_incompatible_agents() {
        struct MockTextGenAdapter {
            kind: AgentKind,
            detect_ok: bool,
            fail_generate: bool,
            calls: Arc<Mutex<Vec<(AgentKind, Option<String>)>>>,
        }

        #[async_trait]
        impl AgentAdapter for MockTextGenAdapter {
            fn kind(&self) -> AgentKind {
                self.kind
            }

            fn capabilities(&self) -> AgentCapabilities {
                match self.kind {
                    AgentKind::CodexCli => AgentCapabilities::codex(),
                    AgentKind::ClaudeCode => AgentCapabilities::claude(),
                    AgentKind::Antigravity => AgentCapabilities::antigravity(),
                    _ => AgentCapabilities::none(),
                }
            }

            async fn detect(&self) -> Result<(), AgentError> {
                if self.detect_ok {
                    Ok(())
                } else {
                    Err(AgentError::Runtime("missing binary".into()))
                }
            }

            async fn generate_text(
                &self,
                _prompt: &str,
                model: Option<&str>,
                _cwd: Option<&Path>,
            ) -> Result<String, AgentError> {
                self.calls
                    .lock()
                    .unwrap()
                    .push((self.kind, model.map(str::to_string)));
                if self.fail_generate {
                    Err(AgentError::Runtime("temporary upstream failure".into()))
                } else {
                    Ok("generated title".into())
                }
            }

            async fn start_session(
                &self,
                _ctx: SessionContext,
                _events: EventSink,
            ) -> Result<Arc<dyn AgentSession>, AgentError> {
                Err(AgentError::Runtime("unused".into()))
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open_in_memory().unwrap());
        let calls = Arc::new(Mutex::new(Vec::new()));
        let calls_ref = Arc::clone(&calls);
        let services = Services::with_adapters(
            Arc::clone(&store),
            DaemonInfo {
                version: "test".into(),
                build: String::new(),
                pid: 1,
                port: 0,
                token: "t".into(),
            },
            dir.path().to_path_buf(),
            Arc::new(move |kind| {
                Arc::new(MockTextGenAdapter {
                    kind,
                    detect_ok: matches!(
                        kind,
                        AgentKind::CodexCli | AgentKind::ClaudeCode | AgentKind::Antigravity
                    ),
                    fail_generate: kind == AgentKind::CodexCli,
                    calls: Arc::clone(&calls_ref),
                })
            }),
        );

        services.runtimes.remember_catalog_for(
            AgentKind::ClaudeCode,
            Some("claude-code"),
            &catalog_with_models(vec![
                model_opt("claude-sonnet-4-6", "Claude Sonnet 4.6", true),
                model_opt("claude-haiku-4-5", "Claude Haiku 4.5", false),
            ]),
        );
        services.runtimes.remember_catalog_for(
            AgentKind::Antigravity,
            Some("antigravity"),
            &catalog_with_models(vec![
                model_opt("gemini-3.1-pro", "Gemini 3.1 Pro", true),
                model_opt("gemini-2.5-flash", "Gemini 2.5 Flash", false),
            ]),
        );

        // 1) Configured instance = codex-cli with explicit model gpt-5-mini; codex fails,
        //    so fallback to claude-code MUST pick claude-haiku-4-5 rather than leaking gpt-5-mini.
        services
            .set_text_gen_settings(TextGenSettings {
                mode: TextGenMode::Auto,
                auto_title: true,
                instance_id: Some("codex-cli".into()),
                model: Some("gpt-5-mini".into()),
                http: None,
            })
            .unwrap();

        let out = services
            .generate_raw_text("hello", Some((AgentKind::ClaudeCode, None)), None)
            .await
            .unwrap();
        assert_eq!(out, "generated title");
        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                (AgentKind::CodexCli, Some("gpt-5-mini".into())),
                (AgentKind::ClaudeCode, Some("claude-haiku-4-5".into())),
            ]
        );

        // 2) No configured instance_id, explicit model = gemini-2.5-flash (owned by antigravity's catalog):
        //    preferred Antigravity receives gemini-2.5-flash because its stored catalog contains it.
        calls.lock().unwrap().clear();
        services
            .set_text_gen_settings(TextGenSettings {
                mode: TextGenMode::Auto,
                auto_title: true,
                instance_id: None,
                model: Some("gemini-2.5-flash".into()),
                http: None,
            })
            .unwrap();
        let out2 = services
            .generate_raw_text("hello", Some((AgentKind::Antigravity, None)), None)
            .await
            .unwrap();
        assert_eq!(out2, "generated title");
        assert_eq!(
            *calls.lock().unwrap(),
            vec![(AgentKind::Antigravity, Some("gemini-2.5-flash".into()))]
        );
    }
}
