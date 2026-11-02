//! 终端：每个终端一个伪终端里的 shell。输出攒成小段推到 `terminal:<id>` 主题，
//! 订阅时先给一份完整回滚内容（`reset`），之后只推新增的部分。
//!
//! 终端属于开它的会话，一直活到界面关掉它、会话被删、shell 自己退出，或 daemon 退出。
//! 看过它的连接都断开（比如界面刷新，标签没了）又过了一阵没人再订阅，也关掉。

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use aiwb_core::rpc::terminal_topic;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::hub::Hub;

/// 订阅时补给界面的回滚内容上限。
const SCROLLBACK_BYTES: usize = 1 << 20;
/// 输出攒这么久再推，避免刷屏时一字节一条推送。
const BATCH: Duration = Duration::from_millis(16);
/// shell 退出后再等这么久，把管道里剩下的输出读完。
const EXIT_DRAIN: Duration = Duration::from_millis(300);
/// 没有连接在看之后再留这么久，等界面重连。
const UNWATCHED_GRACE: Duration = Duration::from_secs(30);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedTerminal {
    pub id: String,
    pub shell: String,
    pub cwd: String,
}

#[derive(Default)]
struct Screen {
    text: String,
    exited: bool,
    exit_code: Option<i32>,
}

struct Terminal {
    /// 所属会话。新会话还没发第一条消息时为空，建好后由界面认领。
    owner: Mutex<Option<String>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    screen: Mutex<Screen>,
}

enum Feed {
    Data(Vec<u8>),
    Exit(Option<i32>),
}

pub struct Terminals {
    hub: Arc<Hub>,
    open: Mutex<HashMap<String, Arc<Terminal>>>,
    /// 终端 → 订阅过它、还连着的连接。
    watchers: Mutex<HashMap<String, HashSet<u64>>>,
}

impl Terminals {
    pub fn new(hub: Arc<Hub>) -> Self {
        Self {
            hub,
            open: Mutex::default(),
            watchers: Mutex::default(),
        }
    }

    pub fn open(&self, cwd: &Path, owner: Option<String>, cols: u16, rows: u16) -> Result<OpenedTerminal, String> {
        if !cwd.is_dir() {
            return Err(format!("工作目录不存在：{}", cwd.display()));
        }
        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(|e| format!("打开终端失败：{e}"))?;
        let shell = default_shell();
        let mut command = CommandBuilder::new(&shell.program);
        command.args(&shell.args);
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| format!("启动 {} 失败：{e}", shell.program))?;
        drop(pair.slave);
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let id = uuid::Uuid::new_v4().simple().to_string();
        let terminal = Arc::new(Terminal {
            owner: Mutex::new(owner),
            killer: Mutex::new(child.clone_killer()),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            screen: Mutex::default(),
        });
        let (feed, inbox) = mpsc::unbounded_channel();

        let output = feed.clone();
        std::thread::spawn(move || read_output(reader, output));
        let waited = terminal.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().map(|status| status.exit_code() as i32);
            // Windows 的伪终端要关掉主端，读端才会结束。
            waited.writer.lock().unwrap().take();
            waited.master.lock().unwrap().take();
            let _ = feed.send(Feed::Exit(code));
        });
        tokio::spawn(pump(self.hub.clone(), terminal_topic(&id), terminal.clone(), inbox));

        self.open.lock().unwrap().insert(id.clone(), terminal);
        Ok(OpenedTerminal {
            id,
            shell: shell.label,
            cwd: cwd.display().to_string(),
        })
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let terminal = self.get(id)?;
        let mut writer = terminal.writer.lock().unwrap();
        let writer = writer.as_mut().ok_or_else(|| "终端已退出".to_string())?;
        writer
            .write_all(data.as_bytes())
            .and_then(|()| writer.flush())
            .map_err(|e| format!("写入终端失败：{e}"))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let terminal = self.get(id)?;
        let master = terminal.master.lock().unwrap();
        match master.as_ref() {
            Some(master) => master.resize(size(cols, rows)).map_err(|e| e.to_string()),
            None => Ok(()),
        }
    }

    /// 新会话发出第一条消息后，把它开着的终端归到建好的会话。
    pub fn adopt(&self, id: &str, session_id: &str) -> Result<(), String> {
        *self.get(id)?.owner.lock().unwrap() = Some(session_id.to_string());
        Ok(())
    }

    /// 会话删掉时，关掉它的终端。
    pub fn close_owned(&self, sessions: &[String]) {
        let ids: Vec<String> = self
            .open
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, terminal)| {
                terminal
                    .owner
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|owner| sessions.contains(owner))
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.close(&id);
        }
    }

    /// 连接订阅了终端主题。
    pub fn watch(&self, id: &str, connection: u64) {
        if self.open.lock().unwrap().contains_key(id) {
            self.watchers.lock().unwrap().entry(id.to_string()).or_default().insert(connection);
        }
    }

    /// 连接断开。它看过的终端没人再看时，过一阵还没人订阅就关掉。
    pub fn forget(self: &Arc<Self>, connection: u64) {
        let orphaned: Vec<String> = {
            let mut watchers = self.watchers.lock().unwrap();
            watchers
                .iter_mut()
                .filter_map(|(id, set)| (set.remove(&connection) && set.is_empty()).then(|| id.clone()))
                .collect()
        };
        for id in orphaned {
            let terminals = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(UNWATCHED_GRACE).await;
                let unwatched = terminals.watchers.lock().unwrap().get(&id).is_none_or(HashSet::is_empty);
                if unwatched {
                    terminals.close(&id);
                }
            });
        }
    }

    pub fn close(&self, id: &str) {
        self.watchers.lock().unwrap().remove(id);
        let terminal = self.open.lock().unwrap().remove(id);
        if let Some(terminal) = terminal {
            let _ = terminal.killer.lock().unwrap().kill();
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = self.open.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }

    /// 订阅时的快照。终端不在了（关掉了或 daemon 重启过）就是一份已退出的空屏。
    pub fn snapshot(&self, id: &str) -> Value {
        let Some(terminal) = self.open.lock().unwrap().get(id).cloned() else {
            return json!({ "reset": true, "data": "", "exited": true, "exitCode": null });
        };
        let screen = terminal.screen.lock().unwrap();
        json!({
            "reset": true,
            "data": screen.text,
            "exited": screen.exited,
            "exitCode": screen.exit_code,
        })
    }

    fn get(&self, id: &str) -> Result<Arc<Terminal>, String> {
        self.open
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "终端不存在".to_string())
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(2),
        cols: cols.max(10),
        pixel_width: 0,
        pixel_height: 0,
    }
}

struct Shell {
    program: String,
    args: Vec<String>,
    label: String,
}

#[cfg(windows)]
fn default_shell() -> Shell {
    let program = if on_path("pwsh.exe") { "pwsh.exe" } else { "powershell.exe" };
    Shell {
        program: program.to_string(),
        args: vec!["-NoLogo".to_string()],
        label: "PowerShell".to_string(),
    }
}

#[cfg(not(windows))]
fn default_shell() -> Shell {
    let program = std::env::var("SHELL")
        .ok()
        .filter(|shell| !shell.trim().is_empty())
        .unwrap_or_else(|| "/bin/sh".to_string());
    let label = Path::new(&program)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| program.clone());
    Shell {
        program,
        args: vec!["-l".to_string()],
        label,
    }
}

#[cfg(windows)]
fn on_path(file: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(file).is_file()))
        .unwrap_or(false)
}

fn read_output(mut reader: Box<dyn Read + Send>, feed: mpsc::UnboundedSender<Feed>) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if feed.send(Feed::Data(buf[..n].to_vec())).is_err() {
                    break;
                }
            }
        }
    }
}

async fn pump(hub: Arc<Hub>, topic: String, terminal: Arc<Terminal>, mut inbox: mpsc::UnboundedReceiver<Feed>) {
    let mut pending: Vec<u8> = Vec::new();
    let mut exit: Option<Option<i32>> = None;
    let take = |feed: Feed, pending: &mut Vec<u8>, exit: &mut Option<Option<i32>>| match feed {
        Feed::Data(bytes) => pending.extend_from_slice(&bytes),
        Feed::Exit(code) => *exit = Some(code),
    };
    while let Some(feed) = inbox.recv().await {
        take(feed, &mut pending, &mut exit);
        tokio::time::sleep(BATCH).await;
        while let Ok(feed) = inbox.try_recv() {
            take(feed, &mut pending, &mut exit);
        }
        if exit.is_some() {
            while let Ok(Some(feed)) = tokio::time::timeout(EXIT_DRAIN, inbox.recv()).await {
                take(feed, &mut pending, &mut exit);
            }
            break;
        }
        publish_output(&hub, &topic, &terminal, &mut pending, false);
    }
    publish_output(&hub, &topic, &terminal, &mut pending, true);
    let code = exit.flatten();
    let _ = hub.publish_with(&topic, || {
        let mut screen = terminal.screen.lock().unwrap();
        screen.exited = true;
        screen.exit_code = code;
        Ok::<_, ()>(((), json!({ "exited": true, "exitCode": code })))
    });
}

/// 推出已经完整的 UTF-8 部分。末尾被截断的多字节字符留到下一批，`flush` 时按原样替换。
fn publish_output(hub: &Hub, topic: &str, terminal: &Terminal, pending: &mut Vec<u8>, flush: bool) {
    let cut = if flush { pending.len() } else { complete_utf8(pending) };
    if cut == 0 {
        return;
    }
    let chunk = String::from_utf8_lossy(&pending[..cut]).into_owned();
    pending.drain(..cut);
    let _ = hub.publish_with(topic, || {
        let mut screen = terminal.screen.lock().unwrap();
        screen.text.push_str(&chunk);
        trim_scrollback(&mut screen.text);
        Ok::<_, ()>(((), json!({ "data": chunk })))
    });
}

/// 去掉末尾不完整的多字节字符后的长度。
fn complete_utf8(bytes: &[u8]) -> usize {
    let len = bytes.len();
    for back in 1..=len.min(3) {
        let byte = bytes[len - back];
        if byte & 0xC0 == 0x80 {
            continue;
        }
        let need = match byte {
            0xF0..=0xFF => 4,
            0xE0..=0xEF => 3,
            0xC0..=0xDF => 2,
            _ => 1,
        };
        return if back < need { len - back } else { len };
    }
    len
}

/// 超出上限时从头裁掉，尽量从整行开始。
fn trim_scrollback(text: &mut String) {
    if text.len() <= SCROLLBACK_BYTES {
        return;
    }
    let mut start = text.len() - SCROLLBACK_BYTES;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    if let Some(newline) = text[start..].find('\n') {
        start += newline + 1;
    }
    text.drain(..start);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_split_multibyte_char_for_next_batch() {
        let text = "终端".as_bytes();
        assert_eq!(complete_utf8(text), text.len());
        assert_eq!(complete_utf8(&text[..4]), 3);
        assert_eq!(complete_utf8(&text[..5]), 3);
        assert_eq!(complete_utf8(b"abc"), 3);
    }

    #[test]
    fn trims_scrollback_from_a_line_start() {
        let mut text = format!("{}\nkeep", "x".repeat(SCROLLBACK_BYTES));
        trim_scrollback(&mut text);
        assert_eq!(text, "keep");
    }
}
