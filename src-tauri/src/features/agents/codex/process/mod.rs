//! 启动 Codex 进程：定位二进制、隐藏控制台、系统代理、stderr 分类。

mod bin;
mod proxy;
mod stderr;

#[cfg(test)]
mod tests;

pub(in crate::features::agents::codex) use bin::{codex_version, hide_console, resolve_codex_bin};
pub(in crate::features::agents::codex) use proxy::apply_codex_network_env;
pub(in crate::features::agents::codex) use stderr::{
    classify_codex_stderr, is_thread_writer_conflict, remember_agent_stderr, trim_newline,
    truncate, StderrClass,
};
