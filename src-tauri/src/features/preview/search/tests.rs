use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::cursor::SearchJob;
use super::{query_indexed_paths, search_blocking, IndexHub, SearchOutput};

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

fn search_until(hub: &IndexHub, root: &Path, query: &str, mask: &str, id: u64) -> SearchOutput {
    let mut guard = 0;
    loop {
        let page = search_blocking(hub, root.to_path_buf(), query, mask, id);
        if page.cancelled || page.done {
            return page;
        }
        guard += 1;
        assert!(guard < 100_000, "search did not finish");
    }
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
    let finished = job.snapshot();
    assert!(finished.hits.iter().any(|hit| hit.path == "z-late/hit.ts"));
    let mut seen = HashSet::new();
    for hit in &finished.hits {
        let key = format!("{}:{}:{}", hit.kind, hit.path, hit.line.unwrap_or(0));
        assert!(seen.insert(key), "duplicate hit {}", hit.path);
    }
    let _ = fs::remove_dir_all(root);
}

#[test]
fn an_older_search_does_not_replace_a_newer_one() {
    let root = scratch("cancel");
    fs::write(root.join("a.ts"), "log\n").unwrap();
    let hub = IndexHub::default();
    hub.finish_for_test(&root);
    let first = search_until(&hub, &root, "log", "*.ts", 2);
    assert!(!first.cancelled);
    assert!(first.hits.iter().any(|hit| hit.path == "a.ts"));
    let bytes = hub.content_bytes(&root);
    assert!(bytes > 0, "content search should have opened the file");
    let stale = search_blocking(&hub, root.clone(), "missing", "*.ts", 1);
    assert!(stale.cancelled);
    assert!(stale.done);
    assert!(stale.hits.is_empty());
    assert_eq!(hub.content_bytes(&root), bytes);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn path_query_does_not_read_file_bytes() {
    let root = scratch("path-only");
    fs::write(root.join("keep.ts"), "needle in the body\n").unwrap();
    let hub = IndexHub::default();
    hub.finish_for_test(&root);
    let found = query_indexed_paths(&hub, root.clone(), "keep", 20, || true);
    assert!(found.ready);
    assert!(found.paths.iter().any(|path| path == "keep.ts"));
    assert_eq!(hub.content_bytes(&root), 0);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn content_search_reads_the_edited_bytes_without_rereading_dirs() {
    let root = scratch("fresh-body");
    fs::write(root.join("a.ts"), "old\n").unwrap();
    let hub = IndexHub::default();
    hub.finish_for_test(&root);
    let reads = hub.read_count(&root);
    fs::write(root.join("a.ts"), "fresh-needle\n").unwrap();
    let found = search_until(&hub, &root, "fresh-needle", "*.ts", 4);
    assert!(found
        .hits
        .iter()
        .any(|hit| hit.kind == "content" && hit.path == "a.ts"));
    assert_eq!(hub.read_count(&root), reads);
    let _ = fs::remove_dir_all(root);
}

#[test]
#[ignore]
fn bench_desktop_temp_cold_index() {
    let root = PathBuf::from(r"C:\Users\admin\Desktop\temp");
    if !root.is_dir() {
        return;
    }
    let hub = IndexHub::default();
    let started = std::time::Instant::now();
    let first = query_indexed_paths(&hub, root.clone(), "package.json", 20, || true);
    let first_call_ms = started.elapsed().as_millis();
    let first_call_ready = first.ready;
    let first_call_hits = first.paths.len();
    let mut first_ms = if first.paths.is_empty() {
        None
    } else {
        Some(first_call_ms)
    };
    let mut first_ready = if first.paths.is_empty() {
        None
    } else {
        Some(first.ready)
    };
    let mut page = first;
    let mut guard = 0;
    let mut partial_pages = 0u32;
    let ready_ms = loop {
        if !page.ready && !page.paths.is_empty() {
            partial_pages += 1;
        }
        if page.ready {
            break started.elapsed().as_millis();
        }
        std::thread::sleep(Duration::from_millis(5));
        page = query_indexed_paths(&hub, root.clone(), "package.json", 20, || true);
        if first_ms.is_none() && !page.paths.is_empty() {
            first_ms = Some(started.elapsed().as_millis());
            first_ready = Some(page.ready);
        }
        guard += 1;
        assert!(guard < 100_000, "index did not finish");
    };
    let path_bytes = hub.content_bytes(&root);
    let (files, dirs) = hub.index_counts(&root);
    let content_started = std::time::Instant::now();
    let mut content_first = None;
    guard = 0;
    let content_done = loop {
        let page = search_blocking(&hub, root.clone(), "export", "*.json", 7);
        if content_first.is_none() && page.hits.iter().any(|hit| hit.kind == "content") {
            content_first = Some(content_started.elapsed().as_millis());
        }
        if page.done {
            break content_started.elapsed().as_millis();
        }
        guard += 1;
        assert!(guard < 100_000, "content search did not finish");
    };
    let line = format!(
        "AFTER dirs={dirs} files={files} path_first_call_ms={first_call_ms} path_first_call_ready={} path_first_call_hits={} path_partial_pages={partial_pages} path_first_package_json_ms={} path_first_ready={} path_complete_ms={ready_ms} path_content_bytes={path_bytes} content_first_export_ms={} content_complete_ms={content_done}\n",
        first_call_ready,
        first_call_hits,
        first_ms.unwrap_or(0),
        first_ready.unwrap_or(false),
        content_first.unwrap_or(0),
    );
    let out_dir = std::env::temp_dir().join("rea-file-index");
    let _ = fs::create_dir_all(&out_dir);
    let _ = fs::write(out_dir.join("after.txt"), &line);
    println!("{line}");
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
