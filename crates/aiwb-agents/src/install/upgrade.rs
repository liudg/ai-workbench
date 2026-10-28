//! 官方更新命令：读取输出并等待退出，没有升级总时限，也不做完成后的探测。

use std::path::Path;
use std::sync::Arc;

use aiwb_core::models::UpdateVia;
use aiwb_proc::decode_child_bytes;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

use super::command::{find_bin, npm_lists_global, tool_command};
use super::{choose_bin, choose_update_via, discover, looks_like_npm_install, BinHit, CliRelease};

pub type UpgradeOutput = Arc<dyn Fn(String) + Send + Sync>;

pub(crate) async fn upgrade_release(
    display_name: &str,
    release: &CliRelease,
    output: UpgradeOutput,
) -> Result<Option<i32>, String> {
    // 只为选择安装入口读取一次。没有最新版查询，也没有升级后的探测。
    let found = discover(release).await;
    let hits: Vec<_> = found
        .iter()
        .map(|item| BinHit {
            name: item.name.clone(),
            version_text: item.version_text.clone(),
        })
        .collect();
    let chosen =
        choose_bin(release, &hits).ok_or_else(|| format!("未找到 {display_name} 的命令"))?;
    let bin = &found
        .iter()
        .find(|item| item.name == chosen.name)
        .ok_or_else(|| format!("未找到 {display_name} 的命令"))?
        .path;

    let npm = if release.npm_package.is_empty() {
        None
    } else {
        find_bin(&["npm"])
    };
    let npm_global = if looks_like_npm_install(bin) {
        true
    } else if chosen.can_update {
        // 原生安装有自己的入口时，不因另一份 npm 安装存在就更新错副本。
        false
    } else if let Some(npm) = &npm {
        npm_lists_global(npm, release.npm_package).await
    } else {
        false
    };
    let via = if release.npm_package.is_empty() {
        UpdateVia::Cli
    } else {
        choose_update_via(bin, npm_global, chosen.can_update)
    };
    match via {
        UpdateVia::Npm => {
            let npm = npm.ok_or_else(|| "未找到 npm，无法按官方方式升级。".to_string())?;
            let spec = format!("{}@latest", release.npm_package);
            run_upgrade(
                &npm,
                &["install", "-g", &spec, "--no-fund", "--no-audit"],
                true,
                output,
            )
            .await
        }
        UpdateVia::Cli => {
            if chosen.update_args.is_empty() {
                return Err(format!("{display_name} 没有官方更新入口"));
            }
            run_upgrade(bin, chosen.update_args, false, output).await
        }
    }
}

async fn run_upgrade(
    bin: &Path,
    args: &[&str],
    npm_quiet: bool,
    output: UpgradeOutput,
) -> Result<Option<i32>, String> {
    let mut command = tool_command(bin, args, npm_quiet);
    // 升级由 daemon 独立持有；丢失请求或观察者不应终止安装器。
    command.kill_on_drop(false);
    let mut child = command
        .spawn()
        .map_err(|err| format!("无法启动 {}：{err}", bin.display()))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    // join 而非 try_join：任何一条输出流出错也要等待进程自然结束。
    let (status, out, err) = tokio::join!(
        child.wait(),
        read_output(stdout, output.clone()),
        read_output(stderr, output.clone()),
    );
    for error in [out.err(), err.err()].into_iter().flatten() {
        output(format!("\n读取更新输出失败：{error}\n"));
    }
    status
        .map(|status| status.code())
        .map_err(|err| format!("等待 {} 退出失败：{err}", bin.display()))
}

async fn read_output(reader: impl AsyncRead + Unpin, output: UpgradeOutput) -> std::io::Result<()> {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line).await? == 0 {
            return Ok(());
        }
        output(decode_child_bytes(&line).into_owned());
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    #[tokio::test]
    async fn upgrade_uses_exit_code_and_never_probes_after_exit() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("agent.cmd");
        let calls = dir.path().join("calls.txt");
        let body = format!(
            "@echo off\r\necho %1>>\"{}\"\r\nif \"%1\"==\"--version\" (echo 1.0.0 & exit /b 0)\r\necho Update failed is only text\r\nexit /b 0\r\n",
            calls.display()
        );
        std::fs::write(&script, &body).unwrap();
        let bin: &'static str = Box::leak(script.to_string_lossy().into_owned().into_boxed_str());
        let bins = Box::leak(vec![bin].into_boxed_slice());
        let release = CliRelease {
            bins,
            npm_package: "",
            self_update: &["update"],
            locate: None,
            version_args: &[],
            aliases: &[],
            note: "",
        };
        let output = Arc::new(Mutex::new(String::new()));
        let captured = output.clone();
        let code = upgrade_release(
            "test",
            &release,
            Arc::new(move |text| captured.lock().unwrap().push_str(&text)),
        )
        .await
        .unwrap();
        assert_eq!(code, Some(0));
        assert!(output.lock().unwrap().contains("Update failed"));
        assert_eq!(
            std::fs::read_to_string(&calls)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            ["--version", "update"]
        );

        std::fs::write(&script, body.replace("exit /b 0\r\n", "exit /b 23\r\n")).unwrap();
        let code = upgrade_release("test", &release, Arc::new(|_| {}))
            .await
            .unwrap();
        assert_eq!(code, Some(23));
        assert_eq!(
            std::fs::read_to_string(&calls)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            ["--version", "update", "--version", "update"]
        );
    }

    #[tokio::test]
    async fn command_survives_the_old_deadlines_and_keeps_both_output_pipes() {
        let dir = tempfile::tempdir().unwrap();
        let release = dir.path().join("release");
        let command = format!(
            "[Console]::Out.WriteLine('ready'); $end = [DateTime]::UtcNow.AddSeconds(20); while (!(Test-Path -LiteralPath '{}')) {{ if ([DateTime]::UtcNow -gt $end) {{ exit 99 }}; Start-Sleep -Milliseconds 10 }}; [Console]::Out.WriteLine('completed'); [Console]::Error.WriteLine('native error detail'); exit 7",
            release.display()
        );
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let run = tokio::spawn(async move {
            run_upgrade(
                Path::new("powershell.exe"),
                &["-NoProfile", "-NonInteractive", "-Command", &command],
                false,
                Arc::new(move |text| {
                    let _ = tx.send(text);
                }),
            )
            .await
        });
        let first = tokio::time::timeout(Duration::from_secs(10), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(first.contains("ready"));
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(601)).await;
        tokio::task::yield_now().await;
        assert!(
            !run.is_finished(),
            "an elapsed deadline must not stop the installer"
        );
        std::fs::write(release, "continue").unwrap();
        tokio::time::resume();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(10), run)
                .await
                .unwrap()
                .unwrap()
                .unwrap(),
            Some(7)
        );
        let mut output = String::new();
        while let Some(text) = rx.recv().await {
            output.push_str(&text);
        }
        assert!(output.contains("completed"));
        assert!(output.contains("native error detail"));
    }

    /// 使用本机真实 npm.cmd；只安装临时测试包到隔离 prefix，不改用户 Agent。
    #[tokio::test]
    #[ignore]
    async fn live_npm_install_in_isolated_prefix() {
        let npm = find_bin(&["npm"]).expect("npm installed");
        let dir = tempfile::tempdir().unwrap();
        let package = dir.path().join("package");
        let prefix = dir.path().join("prefix");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(package.join("package.json"), r#"{"name":"aiwb-upgrade-probe","version":"1.0.0","bin":{"aiwb-upgrade-probe":"index.js"}}"#).unwrap();
        std::fs::write(
            package.join("index.js"),
            "#!/usr/bin/env node\nconsole.log('probe');\n",
        )
        .unwrap();
        let code = run_upgrade(
            &npm,
            &[
                "install",
                "--global",
                "--prefix",
                prefix.to_str().unwrap(),
                package.to_str().unwrap(),
                "--no-fund",
                "--no-audit",
            ],
            true,
            Arc::new(|text| eprint!("{text}")),
        )
        .await
        .unwrap();
        assert_eq!(code, Some(0));
        assert!(prefix.join("aiwb-upgrade-probe.cmd").is_file());
    }
}
