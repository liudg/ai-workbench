//! 工作台自己创建的工作树。侧栏用磁盘上的标记对齐项目，不跑 git。
//!
//! Codex `thread/list` 只带线程的 `cwd`，不会对每条会话做 worktree 识别。
//! 新建会话时才建检出，线程的 cwd 就是检出目录。官方桌面在打开线程之后
//! 会不会再解析工作树，仓库资料里没有，标为未观察。
//!
//! 这里只认 `ai-workbench-worktree.json`。用户自己的链接工作树不会在列会话时归入项目。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::worktree::{read_marker_file, MARKER_NAME};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordedCheckout {
    /// 带 `.git` 文件的检出根。
    pub cwd: PathBuf,
    /// 标记里的检出根，删除时用。
    pub root: PathBuf,
    pub branch: Option<String>,
    pub base: Option<String>,
    pub sha: String,
}

pub struct RecordedWorktrees {
    by_project: Mutex<HashMap<String, Vec<RecordedCheckout>>>,
    codex: Mutex<Option<(String, HashMap<String, Vec<RecordedCheckout>>)>>,
}

impl RecordedWorktrees {
    pub fn new() -> Self {
        Self {
            by_project: Mutex::new(HashMap::new()),
            codex: Mutex::new(None),
        }
    }

    pub fn invalidate(&self) {
        self.by_project.lock().unwrap().clear();
        *self.codex.lock().unwrap() = None;
    }

    /// `codex_root` 是托管根。Claude 的检出在项目 `.claude/worktrees` 下，单独看。
    pub fn for_path(&self, project: &Path, codex_root: &Path) -> Vec<RecordedCheckout> {
        let key = cache_key(project, codex_root);
        if let Some(hit) = self.by_project.lock().unwrap().get(&key) {
            return hit.clone();
        }
        let found = collect(project, codex_root, Some(&self.codex));
        self.by_project.lock().unwrap().insert(key, found.clone());
        found
    }
}

impl Default for RecordedWorktrees {
    fn default() -> Self {
        Self::new()
    }
}

/// 这一次直接读磁盘，不经缓存。测试用它证明读标记不会启动 git。
pub fn recorded_checkouts(project: &Path, codex_root: &Path) -> Vec<RecordedCheckout> {
    collect(project, codex_root, None)
}

pub fn checkout_matches(rows: &[RecordedCheckout], cwd: &str) -> bool {
    rows.iter().any(|row| checkout_contains(row, cwd))
}

pub fn checkout_contains(checkout: &RecordedCheckout, cwd: &str) -> bool {
    let trimmed = cwd.trim();
    if trimmed.is_empty() {
        return false;
    }
    let root = normalize_key(&checkout.root.to_string_lossy());
    let here = normalize_key(&checkout.cwd.to_string_lossy());
    let raw = normalize_key(trimmed);
    if key_within(&raw, &root) || key_within(&raw, &here) {
        return true;
    }
    let cwd_key = normalize_key(&canonical(Path::new(trimmed)).to_string_lossy());
    cwd_key != raw && (key_within(&cwd_key, &root) || key_within(&cwd_key, &here))
}

fn collect(
    project: &Path,
    codex_root: &Path,
    codex_cache: Option<&Mutex<Option<(String, HashMap<String, Vec<RecordedCheckout>>)>>>,
) -> Vec<RecordedCheckout> {
    let Some(common) = git_common_from_disk(project) else {
        return Vec::new();
    };
    let common_key = normalize_key(&common.to_string_lossy());
    let mut found = codex_rows(codex_root, codex_cache)
        .get(&common_key)
        .cloned()
        .unwrap_or_default();
    let claude = project.join(".claude").join("worktrees");
    if claude.is_dir() {
        for dir in checkout_dirs(&claude) {
            if let Some((key, row)) = describe(&dir) {
                if key == common_key {
                    found.push(row);
                }
            }
        }
    }
    found
}

fn codex_rows(
    codex_root: &Path,
    cache: Option<&Mutex<Option<(String, HashMap<String, Vec<RecordedCheckout>>)>>>,
) -> HashMap<String, Vec<RecordedCheckout>> {
    let root_key = normalize_key(&codex_root.to_string_lossy());
    if let Some(cache) = cache {
        let slot = cache.lock().unwrap();
        if let Some((cached_root, rows)) = slot.as_ref() {
            if cached_root == &root_key {
                return rows.clone();
            }
        }
    }
    let rows = index_root(codex_root);
    if let Some(cache) = cache {
        *cache.lock().unwrap() = Some((root_key, rows.clone()));
    }
    rows
}

fn index_root(root: &Path) -> HashMap<String, Vec<RecordedCheckout>> {
    let mut map: HashMap<String, Vec<RecordedCheckout>> = HashMap::new();
    if !root.is_dir() {
        return map;
    }
    for dir in checkout_dirs(root) {
        if let Some((key, row)) = describe(&dir) {
            map.entry(key).or_default().push(row);
        }
    }
    map
}

/// Codex 是 `{根}/{4位}/{仓库名}`，Claude 是 `{根}/{名字}`。只下探两层。
fn checkout_dirs(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if path.join(".git").is_file() {
            out.push(path);
            continue;
        }
        let Ok(children) = fs::read_dir(&path) else {
            continue;
        };
        for child in children.flatten() {
            let child = child.path();
            if child.is_dir() && child.join(".git").is_file() {
                out.push(child);
            }
        }
    }
    out
}

fn describe(dir: &Path) -> Option<(String, RecordedCheckout)> {
    let gitdir = read_gitdir_file(dir)?;
    let common = common_from_gitdir(&gitdir)?;
    let marker = read_marker_file(&gitdir.join(MARKER_NAME))?;
    if !paths_equal(&marker.root, dir) {
        return None;
    }
    let row = RecordedCheckout {
        cwd: canonical(dir),
        root: canonical(&marker.root),
        branch: marker.branch,
        base: marker.base,
        sha: marker.sha,
    };
    Some((normalize_key(&common.to_string_lossy()), row))
}

fn git_common_from_disk(start: &Path) -> Option<PathBuf> {
    if !start.is_dir() {
        return None;
    }
    let mut cur = start.to_path_buf();
    for _ in 0..32 {
        let git = cur.join(".git");
        if git.is_dir() {
            return Some(canonical(&git));
        }
        if git.is_file() {
            let gitdir = read_gitdir_file(&cur)?;
            return common_from_gitdir(&gitdir);
        }
        if !cur.pop() {
            break;
        }
    }
    None
}

fn read_gitdir_file(cwd: &Path) -> Option<PathBuf> {
    let git = cwd.join(".git");
    if !git.is_file() {
        return None;
    }
    let text = fs::read_to_string(git).ok()?;
    let rest = text
        .trim()
        .strip_prefix("gitdir:")?
        .trim()
        .trim_matches('"');
    if rest.is_empty() {
        return None;
    }
    Some(canonical(&resolve_against(cwd, rest)))
}

fn common_from_gitdir(gitdir: &Path) -> Option<PathBuf> {
    let file = gitdir.join("commondir");
    if !file.is_file() {
        return Some(canonical(gitdir));
    }
    let text = fs::read_to_string(file).ok()?;
    let rel = text.trim();
    if rel.is_empty() {
        return None;
    }
    Some(canonical(&resolve_against(gitdir, rel)))
}

fn resolve_against(base: &Path, text: &str) -> PathBuf {
    let raw = PathBuf::from(text);
    if raw.is_absolute() || windows_absolute(text) {
        raw
    } else {
        base.join(raw)
    }
}

fn windows_absolute(text: &str) -> bool {
    let bytes = text.as_bytes();
    if text.starts_with(r"\\") || text.starts_with("//") {
        return true;
    }
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize()
        .map(|item| {
            PathBuf::from(crate::models::strip_verbatim_prefix(
                &item.to_string_lossy(),
            ))
        })
        .unwrap_or_else(|_| path.to_path_buf())
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    normalize_key(&canonical(left).to_string_lossy())
        == normalize_key(&canonical(right).to_string_lossy())
}

fn cache_key(project: &Path, codex_root: &Path) -> String {
    format!(
        "{}|{}",
        normalize_key(&project.to_string_lossy()),
        normalize_key(&codex_root.to_string_lossy())
    )
}

fn normalize_key(path: &str) -> String {
    let stripped = crate::models::strip_verbatim_prefix(path.trim());
    crate::features::agents::cwd_key(&stripped.replace('\\', "/"))
}

fn key_within(path: &str, root: &str) -> bool {
    !root.is_empty() && (path == root || path.starts_with(&format!("{root}/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ai-workbench-recorded-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn marker_files_identify_a_checkout_without_git() {
        let repo = scratch("repo");
        let gitdir = repo.join(".git").join("worktrees").join("demo");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        let managed = scratch("managed");
        let checkout = managed.join("ab12").join("demo");
        fs::create_dir_all(checkout.join("src")).unwrap();
        fs::write(
            checkout.join(".git"),
            format!("gitdir: {}\n", gitdir.display()),
        )
        .unwrap();
        fs::write(
            gitdir.join(MARKER_NAME),
            serde_json::json!({
                "version": 1,
                "base": "main",
                "sha": "abcdef1234567890",
                "root": checkout,
            })
            .to_string(),
        )
        .unwrap();

        let guard = crate::features::git::block_git();
        let found = recorded_checkouts(&repo, &managed);
        assert_eq!(guard.calls(), 0);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].base.as_deref(), Some("main"));
        assert_eq!(found[0].sha, "abcdef1234567890");
        assert!(checkout_contains(
            &found[0],
            &checkout.join("src").to_string_lossy()
        ));
        assert!(!checkout_contains(&found[0], &repo.to_string_lossy()));

        let claude = repo.join(".claude").join("worktrees").join("wt-abc");
        fs::create_dir_all(&claude).unwrap();
        let claude_gitdir = repo.join(".git").join("worktrees").join("wt-abc");
        fs::create_dir_all(&claude_gitdir).unwrap();
        fs::write(claude_gitdir.join("commondir"), "../..\n").unwrap();
        fs::write(
            claude.join(".git"),
            format!("gitdir: {}\n", claude_gitdir.display()),
        )
        .unwrap();
        fs::write(
            claude_gitdir.join(MARKER_NAME),
            serde_json::json!({
                "version": 1,
                "base": "main",
                "sha": "abcdef1234567890",
                "branch": "worktree-wt-abc",
                "root": claude,
            })
            .to_string(),
        )
        .unwrap();
        let again = recorded_checkouts(&repo, &managed);
        assert_eq!(guard.calls(), 0);
        assert_eq!(again.len(), 2);
        let claude_row = again
            .iter()
            .find(|row| row.branch.as_deref() == Some("worktree-wt-abc"))
            .unwrap();
        assert!(checkout_contains(claude_row, &claude.to_string_lossy()));
        drop(guard);
        let _ = fs::remove_dir_all(repo);
        let _ = fs::remove_dir_all(managed);
    }
}
