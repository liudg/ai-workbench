//! 各 CLI 的参数拼装。测试只检查参数，不启动 CLI，也不碰用户配置。

use aiwb_core::models::McpAddSpec;

use super::parse::{env_arg, header_arg, require_name, require_new_name};

pub fn codex_list() -> Vec<String> {
    vec!["mcp".into(), "list".into(), "--json".into()]
}

pub fn codex_remove(name: &str) -> Result<Vec<String>, String> {
    Ok(vec!["mcp".into(), "remove".into(), require_name(name)?])
}

pub fn codex_logout(name: &str) -> Result<Vec<String>, String> {
    Ok(vec!["mcp".into(), "logout".into(), require_name(name)?])
}

pub fn codex_login(name: &str, registration: &str, scopes: &str) -> Result<Vec<String>, String> {
    let mut args = vec!["mcp".into(), "login".into(), require_name(name)?];
    push_registration(&mut args, registration)?;
    push_scopes(&mut args, scopes)?;
    reject_browser_flag(&args)?;
    Ok(args)
}

pub fn codex_add(spec: &McpAddSpec) -> Result<Vec<String>, String> {
    reject_unsupported(
        spec,
        &["stdio", "streamable_http"],
        &["scope", "headers", "callback_port"],
    )?;
    let name = require_new_name(&spec.name)?;
    let mut args = vec!["mcp".into(), "add".into(), name];
    match spec.transport.as_str() {
        "stdio" => {
            require_text(&spec.command, "STDIO 需要启动命令。")?;
            reject_text(&spec.url, "URL 只用于流式 HTTP。")?;
            reject_text(
                &spec.bearer_token_env_var,
                "Bearer 令牌环境变量只用于流式 HTTP。",
            )?;
            reject_text(&spec.client_id, "OAuth 客户端 ID 只用于流式 HTTP。")?;
            reject_text(&spec.client_secret, "OAuth 客户端密钥只用于流式 HTTP。")?;
            reject_text(&spec.oauth_resource, "OAuth 资源只用于流式 HTTP。")?;
            reject_text(
                &spec.oauth_registration,
                "OAuth 客户端注册只用于流式 HTTP。",
            )?;
            for pair in &spec.env {
                args.push("--env".into());
                args.push(env_arg(&pair.key, &pair.value)?);
            }
            args.push("--".into());
            args.push(spec.command.trim().to_string());
            for arg in &spec.args {
                if arg.chars().any(|ch| ch == '\n' || ch == '\r') {
                    return Err("参数不能换行。".into());
                }
                args.push(arg.clone());
            }
        }
        "streamable_http" => {
            require_text(&spec.url, "流式 HTTP 需要 URL。")?;
            reject_text(&spec.command, "命令只用于 STDIO。")?;
            if !spec.args.is_empty() {
                return Err("参数只用于 STDIO。".into());
            }
            if !spec.env.is_empty() {
                return Err("环境变量只用于 STDIO。".into());
            }
            args.push("--url".into());
            args.push(spec.url.trim().to_string());
            if !spec.bearer_token_env_var.trim().is_empty() {
                args.push("--bearer-token-env-var".into());
                args.push(env_name(&spec.bearer_token_env_var)?);
            }
            push_codex_oauth(&mut args, spec)?;
        }
        other => return Err(format!("Codex 不支持传输类型 {other}。")),
    }
    Ok(args)
}

pub fn claude_list() -> Vec<String> {
    vec!["mcp".into(), "list".into()]
}

pub fn claude_remove(name: &str, scope: &str) -> Result<Vec<String>, String> {
    let mut args = vec!["mcp".into(), "remove".into(), require_name(name)?];
    push_scope(&mut args, scope)?;
    Ok(args)
}

pub fn claude_logout(name: &str) -> Result<Vec<String>, String> {
    Ok(vec!["mcp".into(), "logout".into(), require_name(name)?])
}

pub fn claude_login(name: &str, registration: &str, scopes: &str) -> Result<Vec<String>, String> {
    if !registration.trim().is_empty() {
        return Err("Claude 的 login 不支持 --oauth-client-registration。".into());
    }
    if !scopes.trim().is_empty() {
        return Err("Claude 的 login 不支持 --scopes。".into());
    }
    let args = vec!["mcp".into(), "login".into(), require_name(name)?];
    reject_browser_flag(&args)?;
    Ok(args)
}

pub fn claude_add(spec: &McpAddSpec) -> Result<Vec<String>, String> {
    if !spec.bearer_token_env_var.trim().is_empty() {
        return Err("Claude 的 add 没有 --bearer-token-env-var。HTTP 用 Headers。".into());
    }
    if !spec.client_secret.trim().is_empty() {
        return Err("claude mcp add 的 --client-secret 不接收值，会在终端提示。不传。".into());
    }
    if !spec.oauth_resource.trim().is_empty() || !spec.oauth_registration.trim().is_empty() {
        return Err("Claude 的 add 没有 --oauth-resource 或 --oauth-client-registration。".into());
    }
    let name = require_new_name(&spec.name)?;
    let transport = spec.transport.as_str();
    if !matches!(transport, "stdio" | "sse" | "http") {
        return Err(format!("Claude 不支持传输类型 {transport}。"));
    }
    let mut args = vec![
        "mcp".into(),
        "add".into(),
        "--transport".into(),
        transport.into(),
    ];
    push_scope(&mut args, &spec.scope)?;
    if transport == "stdio" {
        if !spec.headers.is_empty() || !spec.client_id.trim().is_empty() || !spec.callback_port.trim().is_empty()
        {
            return Err("Headers、OAuth 客户端 ID 和回调端口只用于 SSE 和 HTTP。".into());
        }
        require_text(&spec.command, "STDIO 需要启动命令。")?;
        reject_text(&spec.url, "URL 只用于 SSE 和 HTTP。")?;
        // `-e` 是变长参数，会一直吃到下一个旗标。名字必须在 `-e` 前面，
        // 命令必须在 `--` 后面，否则服务器名会被当成环境变量。
        args.push(name);
        for pair in &spec.env {
            args.push("-e".into());
            args.push(env_arg(&pair.key, &pair.value)?);
        }
        args.push("--".into());
        args.push(spec.command.trim().to_string());
        for arg in &spec.args {
            if arg.chars().any(|ch| ch == '\n' || ch == '\r') {
                return Err("参数不能换行。".into());
            }
            args.push(arg.clone());
        }
    } else {
        require_text(&spec.url, "SSE 和 HTTP 需要 URL。")?;
        reject_text(&spec.command, "命令只用于 STDIO。")?;
        if !spec.args.is_empty() || !spec.env.is_empty() {
            return Err("参数和环境变量只用于 STDIO。".into());
        }
        if !spec.client_id.trim().is_empty() {
            args.push("--client-id".into());
            args.push(spec.client_id.trim().to_string());
        }
        if !spec.callback_port.trim().is_empty() {
            let port = spec.callback_port.trim();
            if !port.chars().all(|ch| ch.is_ascii_digit()) || port == "0" {
                return Err("回调端口必须是正整数。".into());
            }
            args.push("--callback-port".into());
            args.push(port.to_string());
        }
        args.push(name);
        args.push(spec.url.trim().to_string());
        // `-H` 同样是变长参数，放在名字和 URL 后面，避免把它们吃进去。
        for pair in &spec.headers {
            args.push("-H".into());
            args.push(header_arg(&pair.key, &pair.value)?);
        }
    }
    Ok(args)
}

pub fn cursor_list() -> Vec<String> {
    vec!["mcp".into(), "list".into()]
}

pub fn cursor_login(name: &str) -> Result<Vec<String>, String> {
    Ok(vec!["mcp".into(), "login".into(), require_name(name)?])
}

pub fn cursor_enabled(name: &str, enabled: bool) -> Result<Vec<String>, String> {
    let verb = if enabled { "enable" } else { "disable" };
    Ok(vec!["mcp".into(), verb.into(), require_name(name)?])
}

pub fn cursor_list_tools(name: &str) -> Result<Vec<String>, String> {
    Ok(vec!["mcp".into(), "list-tools".into(), require_name(name)?])
}

pub fn cursor_add_rejected() -> Result<Vec<String>, String> {
    Err("agent mcp 没有 add。帮助会退回父命令。".into())
}

pub fn cursor_remove_rejected() -> Result<Vec<String>, String> {
    Err("agent mcp 没有 remove。帮助会退回父命令。".into())
}

pub fn antigravity_remove(name: &str) -> Result<Vec<String>, String> {
    Ok(vec!["mcp".into(), "remove".into(), require_name(name)?])
}

/// `agy mcp add [flags] <name> <commandOrUrl> [args...]`：旗标必须在名字前面。
pub fn antigravity_add(spec: &McpAddSpec) -> Result<Vec<String>, String> {
    if !spec.scope.trim().is_empty() {
        return Err("agy mcp add 没有 scope。".into());
    }
    if !spec.callback_port.trim().is_empty() {
        return Err("agy mcp add 没有回调端口。".into());
    }
    if !spec.bearer_token_env_var.trim().is_empty() {
        return Err("agy mcp add 没有 --bearer-token-env-var。HTTP 用 Headers。".into());
    }
    if !spec.client_id.trim().is_empty() || !spec.client_secret.trim().is_empty()
        || !spec.oauth_resource.trim().is_empty() || !spec.oauth_registration.trim().is_empty()
    {
        return Err("agy mcp add 没有 OAuth 旗标。".into());
    }
    let name = require_new_name(&spec.name)?;
    let mut args: Vec<String> = vec!["mcp".into(), "add".into()];
    match spec.transport.as_str() {
        "stdio" => {
            require_text(&spec.command, "STDIO 需要启动命令。")?;
            reject_text(&spec.url, "URL 只用于 HTTP。")?;
            if !spec.headers.is_empty() {
                return Err("Headers 只用于 HTTP。".into());
            }
            for pair in &spec.env {
                args.push("--env".into());
                args.push(env_arg(&pair.key, &pair.value)?);
            }
            args.push(name);
            args.push("--".into());
            args.push(spec.command.trim().to_string());
            for arg in &spec.args {
                if arg.chars().any(|ch| ch == '\n' || ch == '\r') {
                    return Err("参数不能换行。".into());
                }
                args.push(arg.clone());
            }
        }
        "http" => {
            require_text(&spec.url, "HTTP 需要 URL。")?;
            reject_text(&spec.command, "命令只用于 STDIO。")?;
            if !spec.args.is_empty() || !spec.env.is_empty() {
                return Err("参数和环境变量只用于 STDIO。".into());
            }
            args.push("--type".into());
            args.push("http".into());
            for pair in &spec.headers {
                args.push("--header".into());
                args.push(header_arg(&pair.key, &pair.value)?);
            }
            args.push(name);
            args.push(spec.url.trim().to_string());
        }
        other => return Err(format!("Antigravity 不支持传输类型 {other}。")),
    }
    Ok(args)
}

fn push_codex_oauth(args: &mut Vec<String>, spec: &McpAddSpec) -> Result<(), String> {
    if !spec.client_id.trim().is_empty() {
        args.push("--oauth-client-id".into());
        args.push(spec.client_id.trim().to_string());
    }
    if !spec.client_secret.trim().is_empty() {
        args.push("--oauth-client-secret".into());
        args.push(spec.client_secret.trim().to_string());
    }
    if !spec.oauth_resource.trim().is_empty() {
        args.push("--oauth-resource".into());
        args.push(spec.oauth_resource.trim().to_string());
    }
    push_registration(args, &spec.oauth_registration)
}

fn push_registration(args: &mut Vec<String>, registration: &str) -> Result<(), String> {
    let registration = registration.trim();
    if registration.is_empty() {
        return Ok(());
    }
    if !matches!(registration, "auto" | "cimd" | "dcr") {
        return Err("OAuth 客户端注册只能是 auto、cimd 或 dcr。".into());
    }
    args.push("--oauth-client-registration".into());
    args.push(registration.to_string());
    Ok(())
}

fn push_scopes(args: &mut Vec<String>, scopes: &str) -> Result<(), String> {
    let scopes = scopes.trim();
    if scopes.is_empty() {
        return Ok(());
    }
    if scopes.chars().any(|ch| ch.is_whitespace() && ch != ' ') || scopes.contains('\n') {
        return Err("scope 不能换行。".into());
    }
    args.push("--scopes".into());
    args.push(scopes.to_string());
    Ok(())
}

fn push_scope(args: &mut Vec<String>, scope: &str) -> Result<(), String> {
    let scope = scope.trim();
    if scope.is_empty() {
        return Ok(());
    }
    if !matches!(scope, "local" | "user" | "project") {
        return Err("配置 scope 只能是 local、user 或 project。".into());
    }
    args.push("-s".into());
    args.push(scope.to_string());
    Ok(())
}

fn reject_unsupported(spec: &McpAddSpec, _allowed: &[&str], flags: &[&str]) -> Result<(), String> {
    for flag in flags {
        let present = match *flag {
            "scope" => !spec.scope.trim().is_empty(),
            "headers" => !spec.headers.is_empty(),
            "callback_port" => !spec.callback_port.trim().is_empty(),
            _ => false,
        };
        if present {
            return Err(match *flag {
                "scope" => "codex mcp 没有 --scope。".into(),
                "headers" => "codex mcp add 没有 --header。".into(),
                "callback_port" => "codex mcp add 没有 --callback-port。".into(),
                _ => "不支持的参数。".into(),
            });
        }
    }
    Ok(())
}

fn reject_browser_flag(args: &[String]) -> Result<(), String> {
    if args.iter().any(|arg| arg == "--no-browser") {
        return Err("不使用 --no-browser。".into());
    }
    Ok(())
}

fn require_text(value: &str, message: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Err(message.into())
    } else {
        Ok(())
    }
}

fn reject_text(value: &str, message: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        Ok(())
    } else {
        Err(message.into())
    }
}

#[cfg(test)]
fn strs(args: &[String]) -> Vec<&str> {
    args.iter().map(String::as_str).collect()
}

fn env_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.contains('=') || value.chars().any(|ch| ch.is_whitespace() || ch.is_control())
    {
        return Err(format!("环境变量名无效：{value}"));
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use aiwb_core::models::McpPair;

    fn spec(transport: &str) -> McpAddSpec {
        McpAddSpec {
            name: "wb-mcp-probe".into(),
            transport: transport.into(),
            command: String::new(),
            args: Vec::new(),
            env: Vec::new(),
            url: String::new(),
            bearer_token_env_var: String::new(),
            headers: Vec::new(),
            scope: String::new(),
            client_id: String::new(),
            client_secret: String::new(),
            oauth_resource: String::new(),
            callback_port: String::new(),
            oauth_registration: String::new(),
        }
    }

    #[test]
    fn codex_stdio_and_http_match_the_help() {
        let mut stdio = spec("stdio");
        stdio.command = "cmd".into();
        stdio.args = vec!["/c".into(), "echo".into()];
        stdio.env = vec![McpPair {
            key: "API_KEY".into(),
            value: "x".into(),
        }];
        assert_eq!(
            strs(&codex_add(&stdio).unwrap()),
            vec![
                "mcp", "add", "wb-mcp-probe", "--env", "API_KEY=x", "--", "cmd", "/c", "echo"
            ]
        );

        let mut http = spec("streamable_http");
        http.url = "https://example.invalid/mcp".into();
        http.bearer_token_env_var = "MCP_BEARER_TOKEN".into();
        http.oauth_registration = "cimd".into();
        let http_args = codex_add(&http).unwrap();
        let args = strs(&http_args);
        assert!(args.contains(&"--url"));
        assert!(args.contains(&"--bearer-token-env-var"));
        assert!(args.contains(&"--oauth-client-registration"));
        assert!(args.contains(&"cimd"));
        assert!(!args.iter().any(|arg| *arg == "--no-browser" || *arg == "--header" || *arg == "--scope"));
    }

    #[test]
    fn codex_rejects_headers_scope_and_hides_login_browser_flag() {
        let mut http = spec("streamable_http");
        http.url = "https://example.invalid/mcp".into();
        http.headers = vec![McpPair {
            key: "X".into(),
            value: "1".into(),
        }];
        assert!(codex_add(&http).unwrap_err().contains("--header"));
        assert_eq!(
            strs(&codex_login("wb-mcp-probe", "auto", "read").unwrap()),
            vec![
                "mcp",
                "login",
                "wb-mcp-probe",
                "--oauth-client-registration",
                "auto",
                "--scopes",
                "read"
            ]
        );
        assert!(codex_login("wb-mcp-probe", "other", "").is_err());
    }

    #[test]
    fn claude_http_uses_headers_scope_and_not_bearer() {
        let mut http = spec("http");
        http.url = "https://example.invalid/mcp".into();
        http.scope = "project".into();
        http.headers = vec![McpPair {
            key: "Authorization".into(),
            value: "Bearer x".into(),
        }];
        http.client_id = "client".into();
        http.callback_port = "8080".into();
        assert_eq!(
            strs(&claude_add(&http).unwrap()),
            vec![
                "mcp",
                "add",
                "--transport",
                "http",
                "-s",
                "project",
                "--client-id",
                "client",
                "--callback-port",
                "8080",
                "wb-mcp-probe",
                "https://example.invalid/mcp",
                "-H",
                "Authorization: Bearer x"
            ]
        );
        http.bearer_token_env_var = "TOKEN".into();
        assert!(claude_add(&http).unwrap_err().contains("bearer"));
        assert!(claude_login("wb-mcp-probe", "auto", "").is_err());
        assert_eq!(
            strs(&claude_remove("wb-mcp-probe", "").unwrap()),
            vec!["mcp", "remove", "wb-mcp-probe"]
        );
    }

    #[test]
    fn claude_stdio_env_keeps_the_server_name_out_of_variadic_env() {
        let mut stdio = spec("stdio");
        stdio.name = "wb-accept-135".into();
        stdio.command = "cmd".into();
        stdio.args = vec!["/c".into(), "echo".into()];
        stdio.scope = "user".into();
        stdio.env = vec![
            McpPair {
                key: "API_KEY".into(),
                value: "x".into(),
            },
            McpPair {
                key: "REGION".into(),
                value: "cn".into(),
            },
        ];
        let added = claude_add(&stdio).unwrap();
        let args = strs(&added);
        assert_eq!(
            args,
            vec![
                "mcp",
                "add",
                "--transport",
                "stdio",
                "-s",
                "user",
                "wb-accept-135",
                "-e",
                "API_KEY=x",
                "-e",
                "REGION=cn",
                "--",
                "cmd",
                "/c",
                "echo"
            ]
        );
        let name_at = args.iter().position(|arg| *arg == "wb-accept-135").unwrap();
        let env_at = args.iter().position(|arg| *arg == "-e").unwrap();
        let dash_at = args.iter().position(|arg| *arg == "--").unwrap();
        assert!(name_at < env_at);
        assert!(env_at < dash_at);
        assert!(!args.windows(2).any(|pair| pair == ["-e", "wb-accept-135"]));
    }

    #[test]
    fn claude_sse_is_a_real_transport_and_stdio_uses_double_dash() {
        let mut sse = spec("sse");
        sse.url = "https://example.invalid/sse".into();
        let added = claude_add(&sse).unwrap();
        let sse_args = strs(&added);
        assert!(sse_args.windows(2).any(|pair| pair == ["--transport", "sse"]));
        let mut stdio = spec("stdio");
        stdio.command = "cmd".into();
        stdio.args = vec!["/c".into()];
        let added = claude_add(&stdio).unwrap();
        let args = strs(&added);
        assert!(args.windows(2).any(|pair| pair == ["--", "cmd"]));
    }

    #[test]
    fn cursor_argv_is_login_list_enable_and_not_add() {
        assert_eq!(strs(&cursor_list()), vec!["mcp", "list"]);
        assert_eq!(strs(&cursor_login("demo").unwrap()), vec!["mcp", "login", "demo"]);
        assert_eq!(
            strs(&cursor_enabled("demo", false).unwrap()),
            vec!["mcp", "disable", "demo"]
        );
        assert!(cursor_add_rejected().is_err());
        assert!(cursor_remove_rejected().is_err());
    }
}
