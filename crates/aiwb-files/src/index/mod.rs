//! 工作区路径索引。只记相对路径，不读文件正文。
//! 目录遵守 .gitignore（含嵌套规则、`.git/info/exclude` 和全局排除），
//! 并用固定跳过列表兜底。扫描在后台进行，查询读当前快照。

mod refresh;
mod scan;

use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

pub(crate) struct Child {
    pub name: String,
    pub rel: String,
    pub path: PathBuf,
    pub is_dir: bool,
}

pub(super) struct DirSnap {
    rel: String,
    abs: PathBuf,
    canon: PathBuf,
    mtime: Option<SystemTime>,
}

pub(crate) struct IndexedFile {
    pub rel: String,
    pub name: String,
    rel_lower: String,
    name_lower: String,
    abs: PathBuf,
}

pub(crate) struct FileIndex {
    root: PathBuf,
    files: Vec<IndexedFile>,
    file_rels: HashSet<String>,
    dirs: Vec<DirSnap>,
    walks: VecDeque<ignore::Walk>,
    seen: HashSet<PathBuf>,
    started: bool,
    complete: bool,
    refresh_queue: Vec<String>,
    last_pass: Option<Instant>,
    reads: u64,
}

impl FileIndex {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            files: Vec::new(),
            file_rels: HashSet::new(),
            dirs: Vec::new(),
            walks: VecDeque::new(),
            seen: HashSet::new(),
            started: false,
            complete: false,
            refresh_queue: Vec::new(),
            last_pass: None,
            reads: 0,
        }
    }

    pub(crate) fn complete(&self) -> bool {
        self.complete
    }

    pub(crate) fn file_count(&self) -> usize {
        self.files.len()
    }

    #[cfg(test)]
    pub(crate) fn dir_count(&self) -> usize {
        self.dirs.len()
    }

    pub(crate) fn file_rel(&self, index: usize) -> &str {
        &self.files[index].rel
    }

    pub(crate) fn file_name(&self, index: usize) -> &str {
        &self.files[index].name
    }

    pub(crate) fn file_abs(&self, index: usize) -> &Path {
        &self.files[index].abs
    }

    #[cfg(test)]
    pub(crate) fn read_count(&self) -> u64 {
        self.reads
    }

    pub(crate) fn matching_paths(
        &self,
        query: &str,
        limit: usize,
    ) -> (Vec<String>, bool) {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() || limit == 0 {
            return (Vec::new(), false);
        }
        let mut paths = Vec::new();
        let mut truncated = false;
        for file in &self.files {
            if !file.rel_lower.contains(&needle) {
                continue;
            }
            if paths.len() >= limit {
                truncated = true;
                break;
            }
            paths.push(file.rel.clone());
        }
        (paths, truncated)
    }

    pub(crate) fn name_matches(
        &self,
        index: usize,
        query_lower: &str,
    ) -> bool {
        !query_lower.is_empty() && self.files[index].name_lower.contains(query_lower)
    }

    /// 跳转文件。空查询按路径返回前 `limit` 个；否则对相对路径做子序列模糊匹配。
    pub(crate) fn quick_open_paths(
        &self,
        query: &str,
        limit: usize,
    ) -> (Vec<String>, bool) {
        if limit == 0 {
            return (Vec::new(), false);
        }
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            let mut paths: Vec<String> = self.files.iter().map(|file| file.rel.clone()).collect();
            paths.sort();
            let truncated = paths.len() > limit;
            paths.truncate(limit);
            return (paths, truncated);
        }
        let mut scored = Vec::new();
        for file in &self.files {
            if let Some(score) = fuzzy_score(&file.rel_lower, &file.name_lower, &needle) {
                scored.push((score, file.rel.clone()));
            }
        }
        scored.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
        let truncated = scored.len() > limit;
        scored.truncate(limit);
        (
            scored.into_iter().map(|(_, path)| path).collect(),
            truncated,
        )
    }
}

fn fuzzy_score(rel_lower: &str, name_lower: &str, query: &str) -> Option<i32> {
    if query.is_empty() {
        return None;
    }
    let rel: Vec<char> = rel_lower.chars().collect();
    let wanted: Vec<char> = query.chars().collect();
    let mut positions = Vec::with_capacity(wanted.len());
    let mut from = 0;
    for ch in wanted {
        let found = rel[from..].iter().position(|item| *item == ch)?;
        let at = from + found;
        positions.push(at);
        from = at + 1;
    }
    let name_start = rel.len().saturating_sub(name_lower.chars().count());
    let mut score = 0;
    let mut previous: Option<usize> = None;
    for (index, pos) in positions.iter().copied().enumerate() {
        let mut bonus = 2;
        if previous == Some(pos.wrapping_sub(1)) && pos > 0 {
            bonus += 10;
        }
        if pos >= name_start {
            bonus += 8;
        }
        if is_boundary(&rel, pos) {
            bonus += 6;
        }
        if index == 0 && pos == name_start {
            bonus += 30;
        }
        score += bonus;
        previous = Some(pos);
    }
    score -= (name_lower.chars().count() as i32).min(40);
    Some(score)
}

fn is_boundary(chars: &[char], pos: usize) -> bool {
    if pos == 0 {
        return true;
    }
    matches!(chars[pos - 1], '/' | '\\' | '_' | '-' | '.' | ' ')
}

impl IndexedFile {
    fn create(abs: PathBuf, rel: String, name: String) -> Self {
        Self {
            rel_lower: rel.to_lowercase(),
            name_lower: name.to_lowercase(),
            rel,
            name,
            abs,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ai-workbench-index-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn finish(index: &mut FileIndex) {
        let mut guard = 0;
        while !index.complete() {
            index.pump_steps(8);
            guard += 1;
            assert!(guard < 100_000, "index did not finish");
        }
    }

    fn rels(index: &FileIndex) -> Vec<String> {
        index.files.iter().map(|file| file.rel.clone()).collect()
    }

    #[test]
    fn a_second_query_does_not_reread_directories() {
        let root = scratch("reuse");
        fs::create_dir_all(root.join("Assets/Scripts")).unwrap();
        fs::write(
            root.join("Assets/Scripts/HomeMainView.cs"),
            "class HomeMain {}\n",
        )
        .unwrap();
        fs::write(root.join("Assets/homeMain.prefab"), "homemain\n").unwrap();
        fs::create_dir_all(root.join("Library")).unwrap();
        fs::write(root.join("Library/keep.cs"), "homemain\n").unwrap();
        for index in 0..40 {
            let dir = root.join(format!("d{index:02}"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("skip.cs"), "nothing\n").unwrap();
        }
        let mut index = FileIndex::new(root.clone());
        finish(&mut index);
        let reads = index.read_count();
        assert!(reads > 1, "expected a real walk, got {reads}");
        let (paths, truncated) = index.matching_paths("homemain", 100);
        assert!(!truncated);
        assert!(
            paths
                .iter()
                .any(|path| path == "Assets/Scripts/HomeMainView.cs"),
            "{paths:?}"
        );
        assert!(
            paths.iter().any(|path| path == "Assets/homeMain.prefab"),
            "{paths:?}"
        );
        assert!(paths.iter().all(|path| !path.starts_with("Library")));
        let (again, _) = index.matching_paths("HomeMain", 100);
        assert_eq!(again, paths);
        assert_eq!(index.read_count(), reads);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn partial_scan_is_not_the_full_result() {
        let root = scratch("partial");
        fs::create_dir_all(root.join("z-late")).unwrap();
        fs::write(root.join("z-late/keep.ts"), "x").unwrap();
        for index in 0..30 {
            let dir = root.join(format!("d{index:02}"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("skip.ts"), "x").unwrap();
        }
        let mut index = FileIndex::new(root.clone());
        index.pump_steps(1);
        assert!(!index.complete());
        let (early, _) = index.matching_paths("keep.ts", 20);
        assert!(
            early.iter().all(|path| path != "z-late/keep.ts"),
            "{early:?}"
        );
        finish(&mut index);
        let (paths, _) = index.matching_paths("keep.ts", 20);
        assert!(
            paths.iter().any(|path| path == "z-late/keep.ts"),
            "{paths:?}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn nested_gitignore_exclude_and_skip_list() {
        let root = scratch("ignore");
        fs::write(root.join(".gitignore"), "secret.txt\nnested/*.log\n").unwrap();
        fs::create_dir_all(root.join(".git/info")).unwrap();
        fs::write(root.join(".git/info/exclude"), "excluded.txt\n").unwrap();
        fs::create_dir_all(root.join("nested")).unwrap();
        fs::write(root.join("nested/.gitignore"), "!keep.log\nskip.md\n").unwrap();
        fs::write(root.join("secret.txt"), "x").unwrap();
        fs::write(root.join("excluded.txt"), "x").unwrap();
        fs::write(root.join("kept.txt"), "x").unwrap();
        fs::write(root.join("nested/keep.log"), "keep").unwrap();
        fs::write(root.join("nested/drop.log"), "drop").unwrap();
        fs::write(root.join("nested/skip.md"), "skip").unwrap();
        fs::write(root.join("nested/ok.ts"), "ok").unwrap();
        fs::create_dir_all(root.join(".github")).unwrap();
        fs::write(root.join(".github/workflows.yml"), "x").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/ok.ts"), "x").unwrap();
        fs::create_dir_all(root.join("Library")).unwrap();
        fs::write(root.join("Library/keep.ts"), "x").unwrap();

        let mut index = FileIndex::new(root.clone());
        finish(&mut index);
        let paths = rels(&index);
        assert!(paths.iter().any(|path| path == "kept.txt"), "{paths:?}");
        assert!(paths.iter().any(|path| path == "nested/ok.ts"), "{paths:?}");
        assert!(
            paths.iter().any(|path| path == "nested/keep.log"),
            "{paths:?}"
        );
        assert!(
            paths.iter().any(|path| path == ".github/workflows.yml"),
            "{paths:?}"
        );
        assert!(paths.iter().all(|path| path != "secret.txt"), "{paths:?}");
        assert!(paths.iter().all(|path| path != "excluded.txt"), "{paths:?}");
        assert!(
            paths.iter().all(|path| path != "nested/drop.log"),
            "{paths:?}"
        );
        assert!(
            paths.iter().all(|path| path != "nested/skip.md"),
            "{paths:?}"
        );
        assert!(
            paths.iter().all(|path| !path.contains("node_modules")),
            "{paths:?}"
        );
        assert!(
            paths.iter().all(|path| !path.starts_with("Library")),
            "{paths:?}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn skip_list_beats_a_gitignore_negation() {
        let root = scratch("skip-wins");
        fs::write(root.join(".gitignore"), "!node_modules\n!node_modules/**\n").unwrap();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/keep.ts"), "x").unwrap();
        fs::write(root.join("keep.ts"), "x").unwrap();
        let mut index = FileIndex::new(root.clone());
        finish(&mut index);
        let paths = rels(&index);
        assert!(paths.iter().any(|path| path == "keep.ts"), "{paths:?}");
        assert!(
            paths.iter().all(|path| !path.contains("node_modules")),
            "{paths:?}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parent_gitignore_applies_when_the_scan_root_is_nested() {
        let root = scratch("parent-ignore");
        fs::write(root.join(".gitignore"), "secret.txt\n").unwrap();
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        fs::write(sub.join("secret.txt"), "x").unwrap();
        fs::write(sub.join("ok.txt"), "x").unwrap();
        let mut index = FileIndex::new(sub);
        finish(&mut index);
        let paths = rels(&index);
        assert!(paths.iter().any(|path| path == "ok.txt"), "{paths:?}");
        assert!(paths.iter().all(|path| path != "secret.txt"), "{paths:?}");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn new_file_is_picked_up_without_rereading_every_directory() {
        let root = scratch("refresh");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/app.cs"), "alpha line\n").unwrap();
        fs::create_dir_all(root.join("other")).unwrap();
        fs::write(root.join("other/note.cs"), "nope\n").unwrap();
        let mut index = FileIndex::new(root.clone());
        finish(&mut index);
        let reads = index.read_count();
        fs::write(root.join("src/added.cs"), "gamma\n").unwrap();
        if let Some(dir) = index.dirs.iter_mut().find(|dir| dir.rel == "src") {
            dir.mtime = Some(SystemTime::UNIX_EPOCH);
        }
        index.last_pass = None;
        index.refresh(std::time::Duration::from_secs(5));
        assert!(
            index.files.iter().any(|file| file.rel == "src/added.cs"),
            "a new file is picked up from the changed directory"
        );
        assert!(index.read_count() > reads);
        assert!(index.read_count() < reads + index.dirs.len() as u64);
        let after = index.read_count();
        index.refresh(std::time::Duration::from_secs(5));
        assert_eq!(
            index.read_count(),
            after,
            "a second refresh inside the gap should not reread"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn quick_open_ranks_filename_matches_and_lists_when_the_query_is_empty() {
        let root = scratch("quick-open");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("app")).unwrap();
        fs::create_dir_all(root.join("Assets/Scripts")).unwrap();
        fs::write(root.join("src/App.tsx"), "export {}\n").unwrap();
        fs::write(root.join("app/readme.md"), "notes\n").unwrap();
        fs::write(root.join("Assets/Scripts/HomeMainView.cs"), "class Home {}\n").unwrap();
        let mut index = FileIndex::new(root.clone());
        finish(&mut index);

        let (empty, truncated) = index.quick_open_paths("", 2);
        assert_eq!(empty.len(), 2);
        assert!(truncated);
        assert!(empty.windows(2).all(|pair| pair[0] <= pair[1]));

        let (ranked, _) = index.quick_open_paths("app", 10);
        assert_eq!(ranked.first().map(String::as_str), Some("src/App.tsx"));
        assert!(ranked.iter().any(|path| path == "app/readme.md"));

        let (fuzzy, _) = index.quick_open_paths("hview", 10);
        assert_eq!(
            fuzzy.first().map(String::as_str),
            Some("Assets/Scripts/HomeMainView.cs")
        );
        assert!(index.quick_open_paths("zzz", 10).0.is_empty());

        let (contains, _) = index.matching_paths("app", 10);
        assert!(contains.iter().any(|path| path == "src/App.tsx"));
        let _ = fs::remove_dir_all(root);
    }
}
