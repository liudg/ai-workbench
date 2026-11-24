use serde::{Deserialize, Serialize};

use super::instance::SECRET_REDACTED;

fn default_true() -> bool {
    true
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// 轻量文本生成的后端模式。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextGenMode {
    /// 自动复用当前会话或本机已就绪的 CLI 实例（无痕禁 MCP 小模型）。
    #[default]
    Auto,
    /// 固定使用指定的本机 CLI 实例与模型。
    Cli,
    /// 直连自定义 OpenAI / Anthropic 兼容 HTTP API。
    Http,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextGenHttpProtocol {
    #[default]
    OpenAi,
    Anthropic,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextGenHttpConfig {
    #[serde(default)]
    pub protocol: TextGenHttpProtocol,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub api_key_redacted: bool,
    pub model: String,
}

/// 专用轻量文本生成通道配置（会话标题、语义分支名、Git 提交说明）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextGenSettings {
    #[serde(default)]
    pub mode: TextGenMode,
    /// `Cli` 模式下绑定的实例 id；`Auto` 时可选作首选兜底实例。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    /// 指定的小模型名（如 `claude-haiku-4-5`、`gpt-5-mini`）；为空时自动挑选轻量档模型。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 首条消息发出后是否异步总结生成会话标题（默认开启）。
    #[serde(default = "default_true")]
    pub auto_title: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http: Option<TextGenHttpConfig>,
}

impl Default for TextGenSettings {
    fn default() -> Self {
        Self {
            mode: TextGenMode::Auto,
            instance_id: None,
            model: None,
            auto_title: true,
            http: None,
        }
    }
}

impl TextGenSettings {
    pub fn redacted(&self) -> Self {
        let mut copy = self.clone();
        if let Some(http) = &mut copy.http {
            if !http.api_key.is_empty() {
                http.api_key.clear();
                http.api_key_redacted = true;
            } else {
                http.api_key_redacted = false;
            }
        }
        copy
    }

    pub fn merge_secrets(&mut self, previous: Option<&TextGenSettings>) {
        if let Some(http) = &mut self.http {
            let masked = http.api_key_redacted || http.api_key == SECRET_REDACTED;
            if masked {
                fn norm_url(u: &str) -> &str {
                    u.trim().trim_end_matches('/')
                }
                if let Some(prev_http) = previous
                    .and_then(|p| p.http.as_ref())
                    .filter(|prev| norm_url(&prev.base_url) == norm_url(&http.base_url))
                {
                    http.api_key = prev_http.api_key.clone();
                } else {
                    http.api_key.clear();
                }
            }
            http.api_key_redacted = false;
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedCommitMessage {
    pub subject: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub body: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_secrets_keeps_key_when_base_url_differs_only_by_trailing_slash_and_clears_otherwise() {
        let prev = TextGenSettings {
            mode: TextGenMode::Http,
            http: Some(TextGenHttpConfig {
                protocol: TextGenHttpProtocol::OpenAi,
                base_url: "https://api.openai.com/v1/".into(),
                api_key: "sk-real-key".into(),
                api_key_redacted: false,
                model: "gpt-5-mini".into(),
            }),
            ..TextGenSettings::default()
        };

        let mut same_host = TextGenSettings {
            mode: TextGenMode::Http,
            http: Some(TextGenHttpConfig {
                protocol: TextGenHttpProtocol::OpenAi,
                base_url: "  https://api.openai.com/v1  ".into(),
                api_key: SECRET_REDACTED.into(),
                api_key_redacted: true,
                model: "gpt-5-mini".into(),
            }),
            ..TextGenSettings::default()
        };
        same_host.merge_secrets(Some(&prev));
        let http = same_host.http.unwrap();
        assert_eq!(http.api_key, "sk-real-key");
        assert!(!http.api_key_redacted);

        let mut changed_host = TextGenSettings {
            mode: TextGenMode::Http,
            http: Some(TextGenHttpConfig {
                protocol: TextGenHttpProtocol::OpenAi,
                base_url: "https://other.example.com/v1".into(),
                api_key: SECRET_REDACTED.into(),
                api_key_redacted: true,
                model: "gpt-5-mini".into(),
            }),
            ..TextGenSettings::default()
        };
        changed_host.merge_secrets(Some(&prev));
        let http = changed_host.http.unwrap();
        assert_eq!(http.api_key, "");
        assert!(!http.api_key_redacted);

        let mut no_prev = TextGenSettings {
            mode: TextGenMode::Http,
            http: Some(TextGenHttpConfig {
                protocol: TextGenHttpProtocol::OpenAi,
                base_url: "https://api.openai.com/v1".into(),
                api_key: SECRET_REDACTED.into(),
                api_key_redacted: false,
                model: "gpt-5-mini".into(),
            }),
            ..TextGenSettings::default()
        };
        no_prev.merge_secrets(None);
        assert_eq!(no_prev.http.unwrap().api_key, "");
    }
}
