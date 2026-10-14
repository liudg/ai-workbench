use super::*;
use serde_json::json;

#[test]
fn merges_config_and_status() {
    let config = json!({
        "config": {
            "mcp_servers": {
                "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] },
                "figma": { "url": "https://mcp.figma.com/mcp", "enabled": true }
            }
        }
    });
    let status = json!({
        "data": [{
            "name": "figma",
            "authStatus": "notLoggedIn",
            "runtimeStatus": "authenticationRequired",
            "tools": { "get_file": {} },
            "resourceTemplates": [],
            "resources": []
        }]
    });
    let servers = merge_mcp_servers(&config, &[status]);
    assert_eq!(servers.len(), 2);
    let figma = servers
        .iter()
        .find(|server| server.name == "figma")
        .unwrap();
    assert_eq!(figma.transport, McpTransport::Http);
    assert_eq!(figma.auth_status, "notLoggedIn");
    assert_eq!(figma.tool_names, vec!["get_file".to_string()]);
    let context = servers
        .iter()
        .find(|server| server.name == "context7")
        .unwrap();
    assert_eq!(context.transport, McpTransport::Stdio);
    assert_eq!(
        context.args,
        vec!["-y".to_string(), "@upstash/context7-mcp".to_string()]
    );
}

#[test]
fn parses_hooks() {
    let hooks = parse_hooks(&json!({
        "data": [{
            "cwd": "C:/repo",
            "errors": [],
            "warnings": [],
            "hooks": [{
                "eventName": "preToolUse",
                "command": "echo hi",
                "handlerType": "command",
                "enabled": true,
                "trustStatus": "untrusted",
                "source": "project",
                "statusMessage": null
            }]
        }]
    }));
    assert_eq!(hooks[0].handler, "echo hi");
    assert!(render_hooks(&hooks).contains("未信任"));
}

#[test]
fn verbose_mcp_mentions_transport() {
    let text = render_mcp(
        &[McpServerRecord {
            name: "figma".into(),
            transport: McpTransport::Http,
            command: String::new(),
            args: Vec::new(),
            url: "https://mcp.figma.com/mcp".into(),
            enabled: true,
            auth_status: "oAuth".into(),
            runtime_status: "connected".into(),
            tool_names: vec!["get_file".into()],
            tools_error: String::new(),
            plugin_id: String::new(),
        }],
        true,
    );
    assert!(text.contains("Streamable HTTP"));
    assert!(text.contains("OAuth"));
}
