use super::bin::{platform_vendor_suffix, vendor_exe_near, version_label};
use super::proxy::{merge_no_proxy, parse_windows_proxy_server, sanitize_proxy_bypass};
use super::*;

#[test]
fn version_label_keeps_the_package_semver() {
    assert_eq!(version_label("codex-cli 0.162.1\n"), "0.162.1");
    assert_eq!(version_label("0.162.1"), "0.162.1");
    assert_eq!(version_label(""), "未知版本");
}

#[test]
fn ignores_optional_mcp_transport_noise() {
    let ansi = "\u{1b}[2m2026-10-10T06:37:02.131976Z\u{1b}[0m \u{1b}[31mERROR\u{1b}[0m \u{1b}[2mrmcp::transport::worker\u{1b}[0m\u{1b}[2m:\u{1b}[0m worker quit with fatal: Transport channel closed, when UnexpectedServerResponse(\"HTTP 502: \")";
    assert!(matches!(classify_codex_stderr(ansi), StderrClass::Log(_)));

    let direct = "2026-10-10T06:45:44.207643Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(HttpRequest(HttpRequest(\"http/request failed: error sending request for url (http://127.0.0.1:8080/mcp)\")))";
    assert!(matches!(classify_codex_stderr(direct), StderrClass::Log(_)));
}

#[test]
fn hides_thread_store_writer_conflict() {
    let persistence = "2026-10-10T09:25:25.276357Z ERROR codex_core::session::session failed to initialize thread persistence: thread-store conflict: thread 01a124c7-226b-7bb0-a774-c5fccdab7471 already has an active writer";
    let create = "2026-10-10T09:25:25.278837Z ERROR codex_core::session Failed to create session: thread-store conflict: thread 01a124c7-226b-7bb0-a774-c5fccdab7471 already has an active writer";
    assert!(matches!(
        classify_codex_stderr(persistence),
        StderrClass::Log(_)
    ));
    assert!(matches!(classify_codex_stderr(create), StderrClass::Log(_)));
    assert!(is_thread_writer_conflict(
        "thread abc already has an active writer"
    ));
    assert!(!is_thread_writer_conflict("authentication failed"));
}

#[test]
fn keeps_real_codex_stderr_errors() {
    let line = "\u{1b}[31m2026-10-10T06:45:41Z ERROR codex_core: authentication failed\u{1b}[0m";
    match classify_codex_stderr(line) {
        StderrClass::Log(message) => {
            assert!(message.contains("authentication failed"));
            assert!(!message.contains('\u{1b}'));
        }
        other => panic!("expected log, got {other:?}"),
    }
    let memory = r"2026-10-11T05:34:12Z ERROR codex_core::tools::router: error=apply_patch verification failed: invalid patch: multiple operations target C:\Users\admin\.codex\memories\memory_summary.md";
    match classify_codex_stderr(memory) {
        StderrClass::Log(message) => assert!(message.contains("memory_summary.md")),
        other => panic!("expected log, got {other:?}"),
    }
    let config = "ERROR codex_app_server: Codex is ignoring 1 unrecognized configuration setting.";
    assert!(matches!(classify_codex_stderr(config), StderrClass::Log(_)));
    assert!(matches!(classify_codex_stderr("  "), StderrClass::Ignore));
}

#[test]
fn no_proxy_includes_loopback() {
    assert_eq!(merge_no_proxy(""), "localhost,127.0.0.1,::1");
    assert_eq!(
        merge_no_proxy("example.com, localhost"),
        "example.com,localhost,127.0.0.1,::1"
    );
}

#[test]
fn parses_windows_proxy_server() {
    assert_eq!(
        parse_windows_proxy_server("127.0.0.1:7897"),
        Some((
            "http://127.0.0.1:7897".into(),
            "http://127.0.0.1:7897".into()
        ))
    );
    assert_eq!(
        parse_windows_proxy_server("http=10.0.0.1:8888;https=10.0.0.2:8889;socks=10.0.0.3:1080"),
        Some(("http://10.0.0.1:8888".into(), "http://10.0.0.2:8889".into()))
    );
    assert_eq!(
        parse_windows_proxy_server("https://proxy.example:443"),
        Some((
            "https://proxy.example:443".into(),
            "https://proxy.example:443".into()
        ))
    );
    assert_eq!(parse_windows_proxy_server(""), None);
    assert_eq!(parse_windows_proxy_server("socks=127.0.0.1:1080"), None);
}

#[test]
fn bypass_list_keeps_domains_and_drops_match_all() {
    let bypass = sanitize_proxy_bypass(
        "localhost;127.*;192.168.*;<local>;*.taole.com;*enterprise.aigcfast*;*",
    );
    assert_eq!(
        bypass,
        vec!["localhost".to_string(), ".taole.com".to_string()]
    );
    let merged = merge_no_proxy(&bypass.join(","));
    assert!(merged.split(',').any(|item| item == "127.0.0.1"));
    assert!(merged.split(',').any(|item| item == ".taole.com"));
    assert!(!merged.split(',').any(|item| item == "*"));
    assert!(!merged.split(',').any(|item| item.contains("127.*")));
}

#[test]
fn vendor_exe_near_finds_npm_prefix_and_package_bin() {
    let Some(suffix) = platform_vendor_suffix() else {
        return;
    };
    let root = std::env::temp_dir().join(format!(
        "ai-workbench-codex-vendor-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_dir_all(&root);
    let prefix_bin = root
        .join("prefix/lib/node_modules/@openai/codex")
        .join(suffix);
    std::fs::create_dir_all(prefix_bin.parent().unwrap()).unwrap();
    std::fs::write(&prefix_bin, b"codex").unwrap();
    let shim_dir = root.join("prefix/bin");
    std::fs::create_dir_all(&shim_dir).unwrap();
    let shim = shim_dir.join("codex");
    std::fs::write(&shim, b"shim").unwrap();
    assert_eq!(
        vendor_exe_near(&shim).as_deref(),
        Some(prefix_bin.as_path())
    );

    let package_bin = root.join("pkg/node_modules/@openai/codex").join(suffix);
    std::fs::create_dir_all(package_bin.parent().unwrap()).unwrap();
    std::fs::write(&package_bin, b"codex").unwrap();
    let script_dir = root.join("pkg/node_modules/@openai/codex/bin");
    std::fs::create_dir_all(&script_dir).unwrap();
    let script = script_dir.join("codex.js");
    std::fs::write(&script, b"script").unwrap();
    assert_eq!(
        vendor_exe_near(&script).as_deref(),
        Some(package_bin.as_path())
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(windows)]
#[test]
fn live_system_proxy_is_an_http_url() {
    let Some(proxy) = super::proxy::read_windows_system_proxy() else {
        return;
    };
    assert!(
        proxy.https.starts_with("http://") || proxy.https.starts_with("https://"),
        "{}",
        proxy.https
    );
    assert!(!proxy.https.contains('*'));
    assert!(proxy.http.contains("://"));
}
