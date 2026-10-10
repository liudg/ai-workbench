//! 子进程输出的字节解码与 UTF-8 环境（本机为中文 Windows，代码页 936 / GBK）。
//!
//! 实测（Codex CLI 0.162.1，zh-CN / CP936）：app-server 的 JSON-RPC、stderr、
//! 命令聚合输出均为规范 UTF-8，无需转码。但旧版 CLI 或树上的第三方工具可能按
//! 系统代码页（GBK）写中文，而 GBK 双字节序列常常是「合法但错误」的 UTF-8
//! （如 D6 D0 CE C4），严格 UTF-8 解码会静默产出乱码；tokio 的 `lines()`
//! 遇到非法 UTF-8 还会直接报错并中断整个读取循环。
//!
//! 解码策略：严格 UTF-8（无 CJK 却有成片生僻区间字符时视为 GBK 误读）
//! → GBK → 置换字符兜底。

use std::borrow::Cow;

/// 注入子进程树的 UTF-8 环境（仅当用户未自行设置）。
/// Windows 原生程序读代码页，不受影响；移植层工具（git、bash、Python）读这些
/// locale 变量，统一改成 UTF-8 后其输出可被上层按 UTF-8 正确接收。
pub const UTF8_ENV: &[(&str, &str)] = &[
    ("LANG", "C.UTF-8"),
    ("LC_CTYPE", "C.UTF-8"),
    ("PYTHONIOENCODING", "utf-8"),
    ("PYTHONUTF8", "1"),
];

pub fn apply_utf8_env(command: &mut tokio::process::Command) {
    for (key, value) in UTF8_ENV {
        if std::env::var_os(key).is_none() {
            command.env(key, value);
        }
    }
}

pub fn apply_utf8_env_std(command: &mut std::process::Command) {
    for (key, value) in UTF8_ENV {
        if std::env::var_os(key).is_none() {
            command.env(key, value);
        }
    }
}

/// 解码子进程输出：优先 UTF-8；疑似 GBK 时按 GBK；都不行退回避换字符。
pub fn decode_child_bytes(bytes: &[u8]) -> Cow<'_, str> {
    match std::str::from_utf8(bytes) {
        Ok(text) if !looks_like_gbk_misread(text) => Cow::Borrowed(text),
        Ok(text) => {
            let (gbk, _, errors) = encoding_rs::GBK.decode(bytes);
            if !errors && gbk.chars().any(is_cjk) {
                gbk
            } else {
                Cow::Borrowed(text)
            }
        }
        Err(_) => {
            let (gbk, _, gbk_errors) = encoding_rs::GBK.decode(bytes);
            if !gbk_errors {
                return gbk;
            }
            let utf8 = String::from_utf8_lossy(bytes);
            let fffd = |s: &str| s.matches('\u{FFFD}').count();
            if fffd(&gbk) <= fffd(&utf8) {
                gbk
            } else {
                utf8
            }
        }
    }
}

/// GBK 字节被误当 UTF-8 解码的典型特征：没有任何 CJK，却出现两个以上
/// 生僻区间字符（GBK 双字节常被映射到 U+0080–U+08FF、U+0C80–U+0DFF）。
fn looks_like_gbk_misread(text: &str) -> bool {
    let mut suspicious = 0usize;
    for ch in text.chars() {
        if is_cjk(ch) {
            return false;
        }
        if matches!(ch, '\u{0080}'..='\u{08FF}' | '\u{0C80}'..='\u{0DFF}') {
            suspicious += 1;
        }
    }
    suspicious >= 2
}

fn is_cjk(ch: char) -> bool {
    matches!(
        ch,
        '\u{3400}'..='\u{4DBF}'
            | '\u{4E00}'..='\u{9FFF}'
            | '\u{3000}'..='\u{303F}'
            | '\u{FF00}'..='\u{FFEF}'
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn passes_utf8_through() {
        let text = "中文 UTF-8 ✓ — 标点：，。";
        assert_eq!(decode_child_bytes(text.as_bytes()), text);
    }

    #[test]
    fn decodes_gbk_bytes_invalid_as_utf8() {
        let gbk = [0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4];
        assert_eq!(decode_child_bytes(&gbk), "中文测试");
    }

    #[test]
    fn repairs_gbk_misread_as_valid_utf8() {
        let gbk = [0xD6, 0xD0, 0xCE, 0xC4];
        assert_eq!(decode_child_bytes(&gbk), "中文");
    }

    #[test]
    fn decodes_gbk_json_line() {
        let mut line = b"{\"text\":\"".to_vec();
        line.extend_from_slice(&[0xD6, 0xD0, 0xCE, 0xC4]);
        line.extend_from_slice(b"\"}");
        let decoded = decode_child_bytes(&line);
        let value: serde_json::Value = serde_json::from_str(&decoded).unwrap();
        assert_eq!(value["text"], json!("中文"));
    }

    #[test]
    fn falls_back_to_replacement_for_unmappable_bytes() {
        let decoded = decode_child_bytes(&[0x41, 0xFF, 0xFF, 0x42]);
        assert!(decoded.starts_with('A'));
        assert!(decoded.ends_with('B'));
        assert!(decoded.contains('\u{FFFD}'));
    }

    #[test]
    fn keeps_ascii_and_plain_utf8_on_fast_path() {
        assert_eq!(decode_child_bytes(b"plain ascii"), "plain ascii");
        assert_eq!(decode_child_bytes("已连接（目录）".as_bytes()), "已连接（目录）");
    }
}
