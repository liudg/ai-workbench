//! 内容搜索。只在这条通道里打开文件，路径索引不读正文。
//! 二进制和超过 1MB 的文件跳过。调用方在两个文件之间检查取消。

use std::io::Read;
use std::path::Path;

use super::{contains_ignore_case, snippet, SearchHit};

const MAX_FILE_BYTES: u64 = 1024 * 1024;

pub(super) struct ReadOutcome {
    pub hits: Vec<SearchHit>,
    pub overflow: bool,
    pub bytes: u64,
}

pub(super) fn scan_file(abs: &Path, rel: &str, query_lower: &str, room: usize) -> ReadOutcome {
    if query_lower.is_empty() || room == 0 {
        return ReadOutcome {
            hits: Vec::new(),
            overflow: false,
            bytes: 0,
        };
    }
    let Some((text, bytes)) = read_text(abs) else {
        return ReadOutcome {
            hits: Vec::new(),
            overflow: false,
            bytes: skipped_bytes(abs),
        };
    };
    let mut hits = Vec::new();
    for (line_index, line) in text.split('\n').enumerate() {
        let line = line.trim_end_matches('\r');
        if !contains_ignore_case(line, query_lower) {
            continue;
        }
        if hits.len() >= room {
            return ReadOutcome {
                hits,
                overflow: true,
                bytes,
            };
        }
        let line_no = u32::try_from(line_index + 1).unwrap_or(u32::MAX);
        hits.push(SearchHit {
            path: rel.to_string(),
            line: Some(line_no),
            text: snippet(line, query_lower),
            kind: "content".into(),
        });
    }
    ReadOutcome {
        hits,
        overflow: false,
        bytes,
    }
}

fn skipped_bytes(path: &Path) -> u64 {
    std::fs::metadata(path)
        .map(|meta| meta.len().min(MAX_FILE_BYTES))
        .unwrap_or(0)
}

fn read_text(path: &Path) -> Option<(String, u64)> {
    let len = std::fs::metadata(path).ok()?.len();
    if len > MAX_FILE_BYTES {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    if file
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return None;
    }
    let read = bytes.len() as u64;
    if read > MAX_FILE_BYTES || bytes.contains(&0) {
        return None;
    }
    String::from_utf8(bytes).ok().map(|text| (text, read))
}
