//! 拉起、连接和停止后台 daemon。
//!
//! daemon 程序和应用放在同一目录（开发时是 cargo target 目录，安装后是 Tauri sidecar）。
//! 先把它复制到数据目录下按构建标识命名的子目录再运行。Windows 不能覆盖正在运行的程序，
//! 这样安装新版本、开发时重新编译都不会被正在跑的 daemon 挡住。
//! 构建标识对不上（升级了，或者开发时重新编译了）就停掉旧的，换成新的。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use aiwb_core::{DaemonInfo, DAEMON_INFO_FILE};
use tauri::{AppHandle, Manager, Runtime};

const DAEMON_EXE: &str = if cfg!(windows) {
    "aiwb-daemon.exe"
} else {
    "aiwb-daemon"
};
const LOG_FILE: &str = "daemon.log";
const START_TIMEOUT: Duration = Duration::from_secs(10);
const IO_TIMEOUT: Duration = Duration::from_millis(800);

/// 同一时间只让一个调用去拉起 daemon。
static LAUNCH: Mutex<()> = Mutex::new(());

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonEndpoint {
    url: String,
    token: String,
}

/// 前端连接前调用；daemon 没在跑或者版本不对时在这里拉起新的。
#[tauri::command]
pub async fn daemon_endpoint<R: Runtime>(app: AppHandle<R>) -> Result<DaemonEndpoint, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    let info = tauri::async_runtime::spawn_blocking(move || ensure_running(&data_dir))
        .await
        .map_err(|e| e.to_string())??;
    Ok(DaemonEndpoint {
        url: info.ws_url(),
        token: info.token,
    })
}

pub fn ensure_running(data_dir: &Path) -> Result<DaemonInfo, String> {
    let _guard = LAUNCH.lock().unwrap_or_else(|p| p.into_inner());
    let source = source_exe()?;
    let build = build_stamp(&source)?;

    if let Some(info) = read_info(data_dir) {
        match health(info.port) {
            // 已有升级命令时继续用原来的 daemon，等命令结束后再替换程序。
            Some(status) if status["build"].as_str() == Some(build.as_str())
                || status["upgrading"].as_u64().unwrap_or(0) > 0 => return Ok(info),
            Some(_) => {
                stop(&info);
                wait_until(|| health_build(info.port).is_none().then_some(()))
                    .ok_or("旧版后台服务没有按时退出")?;
            }
            None => {}
        }
    }

    let exe = launch_exe(data_dir, &source, &build)?;
    spawn(&exe, data_dir, &build)?;
    wait_until(|| {
        read_info(data_dir)
            .filter(|info| info.build == build && health_build(info.port).as_deref() == Some(&build))
    })
    .ok_or_else(|| format!("后台服务没有启动，详情见 {}", data_dir.join(LOG_FILE).display()))
}

/// 还在跑或在等输入的会话数。daemon 没在跑时为 0。
pub fn running_sessions(data_dir: &Path) -> usize {
    let Some(info) = read_info(data_dir) else {
        return 0;
    };
    http(info.port, "GET /health", None)
        .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
        .and_then(|value| value["running"].as_u64())
        .unwrap_or(0) as usize
}

/// 托盘退出时调用。daemon 没在跑就什么也不做。
pub fn shutdown(data_dir: &Path) {
    if let Some(info) = read_info(data_dir) {
        stop(&info);
    }
}

fn source_exe() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = current
        .parent()
        .ok_or("找不到应用所在目录")?
        .join(DAEMON_EXE);
    if exe.is_file() {
        Ok(exe)
    } else {
        Err(format!("找不到后台服务程序：{}", exe.display()))
    }
}

/// 版本号加上程序文件的修改时间和大小。
fn build_stamp(exe: &Path) -> Result<String, String> {
    let meta = std::fs::metadata(exe).map_err(|e| e.to_string())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(format!("{}-{modified}-{}", env!("CARGO_PKG_VERSION"), meta.len()))
}

fn launch_exe(data_dir: &Path, source: &Path, build: &str) -> Result<PathBuf, String> {
    let root = data_dir.join("daemon");
    let dir = root.join(build);
    let exe = dir.join(DAEMON_EXE);
    if !exe.is_file() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("准备后台服务目录失败：{e}"))?;
        let tmp = dir.join(format!("{DAEMON_EXE}.tmp"));
        std::fs::copy(source, &tmp).map_err(|e| format!("复制后台服务失败：{e}"))?;
        std::fs::rename(&tmp, &exe).map_err(|e| format!("复制后台服务失败：{e}"))?;
    }
    // 旧版本的副本：还在运行的删不掉，下次再试。
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            if entry.file_name() != build {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(exe)
}

fn spawn(exe: &Path, data_dir: &Path, build: &str) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| format!("创建数据目录失败：{e}"))?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join(LOG_FILE))
        .map_err(|e| format!("打开 {LOG_FILE} 失败：{e}"))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = Command::new(exe);
    command
        .arg("--data-dir")
        .arg(data_dir)
        .arg("--build")
        .arg(build)
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(log_err);
    detach(&mut command).spawn().map(drop).or_else(|_| {
        // 有的作业对象不允许脱离，退回到不脱离作业。
        plain_detach(&mut command)
            .spawn()
            .map(drop)
            .map_err(|e| format!("启动后台服务失败：{e}"))
    })
}

#[cfg(windows)]
fn detach(command: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    command.creation_flags(windows_flags() | CREATE_BREAKAWAY_FROM_JOB)
}

#[cfg(windows)]
fn plain_detach(command: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    command.creation_flags(windows_flags())
}

#[cfg(windows)]
fn windows_flags() -> u32 {
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
}

#[cfg(unix)]
fn detach(command: &mut Command) -> &mut Command {
    use std::os::unix::process::CommandExt;
    command.process_group(0)
}

#[cfg(unix)]
fn plain_detach(command: &mut Command) -> &mut Command {
    command
}

fn read_info(data_dir: &Path) -> Option<DaemonInfo> {
    let raw = std::fs::read(data_dir.join(DAEMON_INFO_FILE)).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn wait_until<T>(mut check: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if let Some(value) = check() {
            return Some(value);
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// 正在运行的 daemon 的构建标识；连不上返回 None。
fn health_build(port: u16) -> Option<String> {
    health(port)?["build"].as_str().map(str::to_string)
}

fn health(port: u16) -> Option<serde_json::Value> {
    let body = http(port, "GET /health", None)?;
    serde_json::from_str(&body).ok()
}

fn stop(info: &DaemonInfo) {
    let _ = http(info.port, "POST /shutdown", Some(&info.token));
}

/// 回环地址上的一次最简单的 HTTP 请求，返回响应体。
fn http(port: u16, request_line: &str, token: Option<&str>) -> Option<String> {
    let addr = ([127, 0, 0, 1], port).into();
    let mut stream = TcpStream::connect_timeout(&addr, IO_TIMEOUT).ok()?;
    stream.set_read_timeout(Some(IO_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(IO_TIMEOUT)).ok()?;
    let auth = token
        .map(|t| format!("authorization: Bearer {t}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "{request_line} HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-length: 0\r\n{auth}connection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    if !response.starts_with("HTTP/1.1 2") {
        return None;
    }
    response.split_once("\r\n\r\n").map(|(_, body)| body.to_string())
}
