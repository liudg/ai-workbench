use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::cursor::SearchJob;
use super::{ProjectEntry, SearchOutput};

fn scratch(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("ai-workbench-search-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
fn search_workspace(root: &Path, query: &str, mask: &str, limit: usize) -> SearchOutput {
    let mut job = SearchJob::new(0, root.to_path_buf(), query, mask, limit);
    let mut guard = 0;
    while !job.cursor.done {
        job.pump(Duration::from_secs(30));
        guard += 1;
        if guard > 100_000 {
            job.cursor.done = true;
            break;
        }
    }
    job.snapshot()
}

#[test]
fn searches_filenames_and_contents_and_skips_vendor_and_binary() {
    let root = scratch("hits");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/app.ts"),
        "export const log = 1;\nconst other = 2;\n",
    )
    .unwrap();
    fs::write(root.join("src/logger.ts"), "export const value = 1;\n").unwrap();
    fs::write(root.join("notes.md"), "log in markdown\n").unwrap();
    fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
    fs::write(root.join("node_modules/pkg/index.ts"), "log\n").unwrap();
    fs::write(root.join("src/binary.ts"), b"log\0hidden").unwrap();

    let found = search_workspace(&root, "LoG", "*.ts", 100);
    assert!(found.done);
    assert!(!found.cancelled);
    assert!(!found.truncated);
    let labels: Vec<String> = found
        .hits
        .iter()
        .map(|hit| match hit.line {
            Some(line) => format!("{}:{}:{}", hit.kind, hit.path, line),
            None => format!("{}:{}", hit.kind, hit.path),
        })
        .collect();
    assert!(
        labels.iter().any(|item| item == "name:src/logger.ts"),
        "{labels:?}"
    );
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
    assert!(found.done);
    assert_eq!(found.hits[0].line, Some(1));
    assert!(search_workspace(&root, "   ", "*.ts", 100).hits.is_empty());
    let _ = fs::remove_dir_all(root);
}

#[test]
fn stepping_reaches_a_match_that_sorts_after_other_directories() {
    let root = scratch("slices");
    fs::create_dir_all(root.join("z-late")).unwrap();
    fs::write(root.join("z-late/hit.ts"), "open\n").unwrap();
    for index in 0..40 {
        let dir = root.join(format!("d{index:02}"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("skip.ts"), "nothing\n").unwrap();
    }
    let mut job = SearchJob::new(1, root.clone(), "open", "*.ts", 100);
    job.pump_steps(2);
    assert!(!job.cursor.done, "two steps should not finish this tree");
    let mut guard = 0;
    while !job.cursor.done {
        job.pump_steps(3);
        guard += 1;
        assert!(guard < 10_000, "search did not finish");
    }
    assert!(job
        .cursor
        .hits
        .iter()
        .any(|hit| hit.path == "z-late/hit.ts"));
    let mut seen = HashSet::new();
    for hit in &job.cursor.hits {
        let key = format!("{}:{}:{}", hit.kind, hit.path, hit.line.unwrap_or(0));
        assert!(seen.insert(key), "duplicate hit {}", hit.path);
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn an_older_search_does_not_replace_a_newer_one() {
    let root = scratch("cancel");
    fs::write(root.join("a.ts"), "log\n").unwrap();
    let mut entry = ProjectEntry::new(root.clone());
    let first = entry.advance(2, "log", "*.ts", Duration::from_secs(30));
    assert!(!first.cancelled);
    assert!(first.hits.iter().any(|hit| hit.path == "a.ts"));
    let stale = entry.advance(1, "missing", "*.ts", Duration::from_secs(30));
    assert!(stale.cancelled);
    assert!(stale.done);
    assert!(stale.hits.is_empty());
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
    assert!(found.done);
    assert!(found.hits.iter().any(|hit| hit.path == "src/app.ts"));
    let _ = fs::remove_dir_all(root);
}
