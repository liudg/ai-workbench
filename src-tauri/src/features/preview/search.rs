//! 在打开的工作区目录里搜索文件名和文件内容。
//! 工作台没有接入 Codex 的全文搜索 RPC，这里直接读项目目录。

use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use super::skip_tree_dir;
use crate::features::projects::ProjectStore;

const SEARCH_LIMIT: usize = 100;
const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchHit {
    pub path: String,
    pub line: Option<u32>,
    pub text: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SearchOutput {
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
}

#[tauri::command]
pub fn search_project_files(
    store: State<'_, ProjectStore>,
    project_id: String,
    query: String,
    mask: String,
) -> Result<SearchOutput, String> {
    let project = store
        .get(&project_id)
        .ok_or_else(|| "项目不存在".to_string())?;
    Ok(search_workspace(
        Path::new(&project.path),
        &query,
        &mask,
        SEARCH_LIMIT,
    ))
}

pub fn search_workspace(root: &Path, query: &str, mask: &str, limit: usize) -> SearchOutput {
    let query = query.trim();
    if query.is_empty() || limit == 0 || !root.is_dir() {
        return SearchOutput {
            hits: Vec::new(),
            truncated: false,
        };
    }
    let mut hits = Vec::new();
    let mut truncated = false;
    let mut seen = HashSet::new();
    walk(
        root,
        root,
        query,
        mask,
        limit,
        &mut hits,
        &mut truncated,
        &mut seen,
    );
    SearchOutput { hits, truncated }
}

fn walk(
    root: &Path,
    dir: &Path,
    query: &str,
    mask: &str,
    limit: usize,
    hits: &mut Vec<SearchHit>,
    truncated: &mut bool,
    seen: &mut HashSet<PathBuf>,
) {
    if *truncated {
        return;
    }
    let canon = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    if !seen.insert(canon) {
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = read.filter_map(|item| item.ok()).collect();
    entries.sort_by_key(|item| item.file_name());
    for entry in entries {
        if *truncated {
            return;
        }
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if skip_tree_dir(&name) {
                continue;
            }
            walk(root, &path, query, mask, limit, hits, truncated, seen);
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if !mask_matches(mask, &rel) {
            continue;
        }
        if contains_ignore_case(&name, query)
            && !push(
                hits,
                truncated,
                limit,
                SearchHit {
                    path: rel.clone(),
                    line: None,
                    text: name.to_string(),
                    kind: "name".into(),
                },
            )
        {
            return;
        }
        scan_file(&path, &rel, query, limit, hits, truncated);
    }
}

fn scan_file(
    path: &Path,
    rel: &str,
    query: &str,
    limit: usize,
    hits: &mut Vec<SearchHit>,
    truncated: &mut bool,
) {
    if *truncated {
        return;
    }
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() > MAX_FILE_BYTES {
        return;
    }
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return,
    };
    let mut bytes = Vec::new();
    if file
        .by_ref()
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return;
    }
    if bytes.len() as u64 > MAX_FILE_BYTES || bytes.contains(&0) {
        return;
    }
    let Ok(text) = String::from_utf8(bytes) else {
        return;
    };
    for (index, line) in text.split('\n').enumerate() {
        let line = line.trim_end_matches('\r');
        if !contains_ignore_case(line, query) {
            continue;
        }
        let line_no = u32::try_from(index + 1).unwrap_or(u32::MAX);
        if !push(
            hits,
            truncated,
            limit,
            SearchHit {
                path: rel.to_string(),
                line: Some(line_no),
                text: snippet(line, query),
                kind: "content".into(),
            },
        ) {
            return;
        }
    }
}

fn push(hits: &mut Vec<SearchHit>, truncated: &mut bool, limit: usize, hit: SearchHit) -> bool {
    if hits.len() >= limit {
        *truncated = true;
        return false;
    }
    hits.push(hit);
    true
}

fn contains_ignore_case(text: &str, query: &str) -> bool {
    text.to_lowercase().contains(&query.to_lowercase())
}

fn snippet(line: &str, query: &str) -> String {
    const MAX: usize = 160;
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= MAX {
        return line.to_string();
    }
    let lower: String = chars.iter().collect::<String>().to_lowercase();
    let needle = query.to_lowercase();
    let byte_at = lower.find(&needle).unwrap_or(0);
    let start_char = lower[..byte_at].chars().count();
    let needle_chars = needle.chars().count().max(1);
    let from = start_char.saturating_sub(40);
    let mut to = (start_char + needle_chars + 80).min(chars.len());
    if to - from > MAX {
        to = (from + MAX).min(chars.len());
    }
    let mut out: String = chars[from..to].iter().collect();
    if from > 0 {
        out.insert(0, '…');
    }
    if to < chars.len() {
        out.push('…');
    }
    out
}

fn mask_matches(mask: &str, relative: &str) -> bool {
    let patterns = split_masks(mask);
    if patterns.is_empty() {
        return true;
    }
    let file_name = relative.rsplit(['/', '\\']).next().unwrap_or(relative);
    patterns.iter().any(|pattern| {
        if pattern == "*" {
            return true;
        }
        let target = if pattern.contains('/') || pattern.contains('\\') {
            relative
        } else {
            file_name
        };
        glob_match(pattern, target)
    })
}

fn split_masks(mask: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut depth: i32 = 0;
    for ch in mask.chars() {
        match ch {
            '{' => {
                depth += 1;
                current.push(ch);
            }
            '}' => {
                depth = depth.saturating_sub(1);
                current.push(ch);
            }
            ',' | ';' if depth == 0 => {
                let piece = current.trim().to_string();
                if !piece.is_empty() {
                    parts.push(piece);
                }
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    let piece = current.trim().to_string();
    if !piece.is_empty() {
        parts.push(piece);
    }
    parts.into_iter().flat_map(|part| expand_braces(&part)).collect()
}

fn expand_braces(pattern: &str) -> Vec<String> {
    let Some(start) = pattern.find('{') else {
        return vec![pattern.to_string()];
    };
    let Some(end_rel) = pattern[start + 1..].find('}') else {
        return vec![pattern.to_string()];
    };
    let end = start + 1 + end_rel;
    let prefix = &pattern[..start];
    let suffix = &pattern[end + 1..];
    let inner = &pattern[start + 1..end];
    inner
        .split(',')
        .map(|part| format!("{prefix}{}{suffix}", part.trim()))
        .filter(|part| !part.is_empty())
        .collect()
}

fn glob_match(pattern: &str, text: &str) -> bool {
    let pat: Vec<char> = pattern.to_lowercase().chars().collect();
    let text: Vec<char> = text.to_lowercase().chars().collect();
    glob_rec(&pat, &text)
}

fn glob_rec(pat: &[char], text: &[char]) -> bool {
    let mut i = 0;
    let mut j = 0;
    while i < pat.len() {
        if pat[i] == '*' {
            let double = i + 1 < pat.len() && pat[i + 1] == '*';
            i += if double { 2 } else { 1 };
            if i == pat.len() {
                return double || !text[j..].contains(&'/');
            }
            let end = text.len();
            for k in j..=end {
                if !double && text[j..k].contains(&'/') {
                    break;
                }
                if glob_rec(&pat[i..], &text[k..]) {
                    return true;
                }
            }
            return false;
        }
        if j >= text.len() {
            return false;
        }
        if pat[i] == '?' {
            if text[j] == '/' {
                return false;
            }
            i += 1;
            j += 1;
            continue;
        }
        if pat[i] != text[j] {
            return false;
        }
        i += 1;
        j += 1;
    }
    j == text.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-workbench-search-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn mask_matches_extensions_braces_and_leaves_other_files() {
        assert!(mask_matches("*.ts", "src/app.ts"));
        assert!(mask_matches("*.ts", "src/App.TS"));
        assert!(!mask_matches("*.ts", "src/app.tsx"));
        assert!(mask_matches("*.{ts,tsx}", "src/app.tsx"));
        assert!(mask_matches("*.ts, *.md", "notes.md"));
        assert!(!mask_matches("*.ts, *.md", "pic.png"));
        assert!(mask_matches("", "pic.png"));
        assert!(mask_matches("*", "pic.png"));
    }

    #[test]
    fn searches_filenames_and_contents_and_skips_vendor_and_binary() {
        let root = scratch("hits");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/app.ts"), "export const log = 1;\nconst other = 2;\n").unwrap();
        fs::write(root.join("src/logger.ts"), "export const value = 1;\n").unwrap();
        fs::write(root.join("notes.md"), "log in markdown\n").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.ts"), "log\n").unwrap();
        fs::write(root.join("src/binary.ts"), b"log\0hidden").unwrap();

        let found = search_workspace(&root, "LoG", "*.ts", 100);
        assert!(!found.truncated);
        let labels: Vec<String> = found
            .hits
            .iter()
            .map(|hit| match hit.line {
                Some(line) => format!("{}:{}:{}", hit.kind, hit.path, line),
                None => format!("{}:{}", hit.kind, hit.path),
            })
            .collect();
        assert!(labels.iter().any(|item| item == "name:src/logger.ts"), "{labels:?}");
        assert!(
            labels.iter().any(|item| item == "content:src/app.ts:1"),
            "{labels:?}"
        );
        assert!(labels.iter().all(|item| !item.contains("notes.md")));
        assert!(labels.iter().all(|item| !item.contains("node_modules")));
        assert!(labels.iter().all(|item| !item.contains("binary")));
        assert!(found.hits.iter().any(|hit| hit.text.contains("log")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn caps_results_at_the_requested_limit() {
        let root = scratch("cap");
        let mut body = String::new();
        for index in 0..120 {
            body.push_str(&format!("log {index}\n"));
        }
        fs::write(root.join("many.ts"), body).unwrap();
        let found = search_workspace(&root, "log", "*.ts", 100);
        assert_eq!(found.hits.len(), 100);
        assert!(found.truncated);
        assert_eq!(found.hits[0].line, Some(1));
        assert!(search_workspace(&root, "   ", "*.ts", 100).hits.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn directory_symlink_cycles_do_not_loop() {
        let root = scratch("cycle");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/app.ts"), "log\n").unwrap();
        std::os::unix::fs::symlink(root.join("src"), root.join("src/again")).unwrap();
        let found = search_workspace(&root, "log", "*.ts", 100);
        assert!(found.hits.iter().any(|hit| hit.path == "src/app.ts"));
        let _ = fs::remove_dir_all(root);
    }
}
